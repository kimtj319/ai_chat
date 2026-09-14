import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/client";
import { ApiError } from "../api/client";
import type { RagDocument, RagDocumentScope, SharedRagDocument } from "../api/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { DocumentViewer } from "./DocumentViewer";
import "./DocumentsPage.css";

/**
 * 올린 문서를 관리하는 화면.
 *
 * 카드가 아니라 표에 가까운 행 목록인 이유는, 이 화면에서 하는 일이 읽기가
 * 아니라 고르고 치우기이기 때문이다. 카드로는 아홉 건이 한 화면에 안 들어왔고,
 * 아홉 건을 지우려면 클릭 열여덟 번에 확인 대화상자 아홉 번이었다.
 *
 * 그래서 관리 동작은 **선택**을 통해 한다. 하나라도 고르면 동작 막대가 나타나고,
 * 확인은 묶음당 한 번이다. 행 하나만 다루고 싶으면 그 행만 고르면 되므로,
 * 행마다 버튼을 늘어놓을 이유가 없어진다 — 늘어놓으면 아홉 줄에 같은 버튼이
 * 열여덟 개 보이고, 그 자체가 이 화면을 읽기 어렵게 만들던 것이다.
 */

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 확인 문구에 들어갈 이름. 셋까지 대고 나머지는 세어 준다 — 스무 개를 늘어놓으면 무엇을 지우는지 오히려 안 읽힌다. */
function namesOf(docs: RagDocument[]): string {
  const names = docs.map((d) => d.name);
  const head = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${head} 외 ${names.length - 3}개` : head;
}

/** 올리는 중인 한 파일의 진행. `total` 은 나뉜 조각 수(나뉘지 않았으면 1)다. */
interface Progress {
  file: string;
  message: string;
  done: number;
  total: number;
}

interface Props {
  onBack: () => void;
}

export function DocumentsPage({ onBack }: Props) {
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  /** 누가 올렸든 전체 공개된 것. 내 것도 여기에 들어간다. */
  const [shared, setShared] = useState<SharedRagDocument[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [maxBytes, setMaxBytes] = useState(512 * 1024);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 올리는 중인 파일과 그 진행. null 이면 아무것도 올리고 있지 않다. */
  const [progress, setProgress] = useState<Progress | null>(null);
  /** ids of rows being changed right now — the whole selection during a bulk action. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [confirming, setConfirming] = useState<RagDocument[] | null>(null);
  const [viewing, setViewing] = useState<RagDocument | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api.listDocuments();
      setDocuments(body.documents);
      setShared(body.shared ?? []);
      setEnabled(body.enabled);
      setMaxBytes(body.maxBytes);
      setError(null);
      // A document that has gone stops being selected — acting on it later
      // would be acting on nothing.
      setSelected((prev) => new Set(body.documents.filter((d) => prev.has(d.id)).map((d) => d.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((d) => d.name.toLowerCase().includes(needle));
  }, [documents, filter]);

  const visibleShared = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return shared;
    return shared.filter((d) => d.name.toLowerCase().includes(needle));
  }, [shared, filter]);

  const chosen = useMemo(() => documents.filter((d) => selected.has(d.id)), [documents, selected]);
  const allVisibleChosen = visible.length > 0 && visible.every((d) => selected.has(d.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleChosen) for (const d of visible) next.delete(d.id);
      else for (const d of visible) next.add(d.id);
      return next;
    });
  }

  async function upload(files: File[]) {
    setError(null);
    setNotice(null);
    for (const file of files) {
      setProgress({ file: file.name, message: "올리는 중…", done: 0, total: 1 });
      try {
        // 올릴 때는 늘 '나만'. 공개는 따로 누르는 일이라야 한다.
        const docs = await api.uploadDocument(file.name, file, "private", (event) => {
          // 서버가 실제 단계를 보낸다. 막대가 진실이라, 멈췄으면 멈춘 것이 보인다.
          if (event.type === "stage") setProgress((p) => (p ? { ...p, message: event.message } : p));
          else if (event.type === "split") setProgress((p) => (p ? { ...p, message: event.message, total: event.total } : p));
          else if (event.type === "part") setProgress((p) => (p ? { ...p, message: event.message, total: event.total } : p));
          else if (event.type === "chunks")
            // 단락 단위. 조각이 하나뿐인 문서는 이것이 유일한 진행 신호다.
            setProgress((p) => (p ? { ...p, message: event.message, done: event.indexed, total: event.total } : p));
          else if (event.type === "indexed")
            setProgress((p) => (p ? { ...p, done: event.index, total: event.total } : p));
        });
        setDocuments((prev) => [...docs, ...prev.filter((d) => !docs.some((n) => n.id === d.id))]);
        const chunks = docs.reduce((sum, d) => sum + d.chunks, 0);
        // 서버는 빈 결과를 주지 않지만(그때는 예외다) 타입이 그걸 모르므로
        // 첫 문서가 없을 때의 이름도 정해 둔다.
        const first = docs[0]?.name ?? file.name;
        setNotice(
          docs.length > 1
            ? `${file.name} — 너무 커서 ${docs.length}개로 나누어 ${chunks}개 단락으로 색인했습니다.`
            : `${first} — ${chunks}개 단락으로 색인했습니다.`,
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : `${file.name} 업로드에 실패했습니다.`);
        await reload();
        break;
      } finally {
        setProgress(null);
      }
    }
  }

  function pick(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length > 0) void upload(files);
  }

  /**
   * 고른 문서들에 같은 일을 차례로 한다.
   *
   * 차례로 하는 이유는 서버가 계정별로 색인을 한 줄로 세우기 때문이다 —
   * 동시에 보내도 거기서 줄을 서므로 빨라지지 않고, 어디까지 됐는지만 알기
   * 어려워진다. 그리고 **일부만 실패했을 때 몇 건이 되고 몇 건이 남았는지**
   * 말해 준다. 묶음 작업에서 그 말이 없으면 다시 눌러도 되는지 알 수 없다.
   */
  async function runBulk(
    docs: RagDocument[],
    verb: string,
    each: (doc: RagDocument) => Promise<RagDocument | null>,
  ) {
    setError(null);
    setNotice(null);
    setBusy(new Set(docs.map((d) => d.id)));
    let done = 0;
    const failures: string[] = [];
    for (const doc of docs) {
      try {
        const updated = await each(doc);
        done++;
        setDocuments((prev) =>
          updated ? prev.map((d) => (d.id === updated.id ? updated : d)) : prev.filter((d) => d.id !== doc.id),
        );
        if (!updated) setSelected((prev) => {
          const next = new Set(prev);
          next.delete(doc.id);
          return next;
        });
      } catch (err) {
        failures.push(`${doc.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(new Set());
    if (failures.length === 0) {
      setNotice(`${done}건을 ${verb}.`);
    } else {
      setNotice(done > 0 ? `${done}건을 ${verb}.` : null);
      setError(`${failures.length}건은 실패했습니다 — ${failures.slice(0, 2).join(" / ")}`);
    }
  }

  const setScope = (docs: RagDocument[], scope: RagDocumentScope) =>
    runBulk(docs, scope === "shared" ? "모두에게 공개했습니다" : "나만 보기로 바꿨습니다", (d) =>
      api.setDocumentScope(d.id, scope),
    );

  const retry = (docs: RagDocument[]) => runBulk(docs, "다시 색인했습니다", (d) => api.retryDocument(d.id));

  const remove = (docs: RagDocument[]) =>
    runBulk(docs, "지웠습니다", async (d) => {
      await api.deleteDocument(d.id);
      return null;
    });

  const sharedCount = documents.filter((d) => d.scope === "shared").length;
  const working = busy.size > 0 || progress !== null;

  return (
    <div className="documents-page">
      <header className="documents-header">
        <button type="button" className="btn-icon" onClick={onBack} data-tooltip="채팅으로 돌아가기" aria-label="채팅으로 돌아가기">
          <BackIcon />
        </button>
        <div className="documents-header-text">
          <h1 className="documents-title">문서</h1>
          <p className="documents-subtitle">
            {loading ? "불러오는 중…" : `내 문서 ${documents.length}개${sharedCount > 0 ? ` · 전체 공개 ${sharedCount}개` : ""}`}
          </p>
        </div>
        {documents.length > 3 && (
          <input
            type="search"
            className="documents-filter"
            placeholder="이름으로 거르기"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="이름으로 거르기"
          />
        )}
        <button type="button" className="btn" disabled={!enabled || working} onClick={() => fileInput.current?.click()}>
          문서 올리기
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="documents-file-input"
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </header>

      <div
        className="documents-body"
        data-dragging={dragging || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (enabled && !working) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (enabled && !working) pick(e.dataTransfer.files);
        }}
      >
        {/* 알림은 목록과 함께 스크롤되지 않는다. 예전에는 맨 위에만 그려서,
            문서가 여남은 개만 돼도 실패 문구가 화면 밖에 있었다 — 올린 사람
            눈에는 아무 일도 일어나지 않은 것처럼 보인다. */}
        <div className="documents-banners">
          {!enabled && (
            <p className="documents-error" role="alert">
              이 서버에는 문서 색인이 설정되어 있지 않습니다. 관리자에게 알려 주세요.
            </p>
          )}
          {error && (
            <p className="documents-error" role="alert">
              <span>{error}</span>
              <button type="button" className="documents-banner-close" onClick={() => setError(null)} aria-label="알림 닫기">
                ×
              </button>
            </p>
          )}
          {notice && !error && (
            <p className="documents-notice" role="status">
              {notice}
            </p>
          )}
          {progress && (
            <div className="documents-progress" role="status" aria-live="polite">
              <div className="documents-progress-head">
                <span className="documents-progress-file">{progress.file}</span>
                <span className="documents-progress-msg">{progress.message}</span>
                {progress.total > 1 && (
                  <span className="documents-progress-count">
                    {progress.done} / {progress.total}
                  </span>
                )}
              </div>
              {/* 조각이 여럿일 때만 비율을 그린다. 하나짜리는 끝나는 시점을
                  알 수 없으므로 채워지는 시늉 대신 계속 흐르게 둔다. */}
              <div
                className="documents-progress-track"
                data-indeterminate={progress.total <= 1 || undefined}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.total > 1 ? progress.done : undefined}
              >
                <div
                  className="documents-progress-fill"
                  style={progress.total > 1 ? { width: `${Math.round((progress.done / progress.total) * 100)}%` } : undefined}
                />
              </div>
            </div>
          )}
        </div>

        {documents.length === 0 && shared.length === 0 && !loading ? (
          <div className="documents-empty">
            <p className="documents-empty-title">아직 올린 문서가 없습니다.</p>
            <p>
              여기에 올린 문서는 대화 중에 모델이 <strong>사내 문서 검색</strong> 도구로 찾아 근거로 씁니다. 올린
              문서는 기본적으로 <strong>나만</strong> 검색되고, 원하면 문서마다 전체 공개로 바꿀 수 있습니다.
            </p>
            <p className="documents-empty-note">
              .txt · .md · .csv 와 <strong>글자로 된 PDF</strong> 를 받습니다. 창 아무 곳에나 끌어다 놓아도 됩니다.
              글 파일은 한 개당 {formatBytes(maxBytes)}까지이고, PDF 는 20MB까지 받되 꺼낸 글자가 그 한도 안이어야
              합니다. 종이를 스캔해 넣은 PDF 는 글자가 아니라 사진이라 검색할 수 없습니다.
            </p>
          </div>
        ) : (
          <>
            <div className="documents-toolbar" data-active={chosen.length > 0 || undefined}>
              <label className="documents-check">
                <input
                  type="checkbox"
                  checked={allVisibleChosen}
                  ref={(el) => {
                    // 일부만 골랐을 때는 '부분' 상태로 보여 준다 — 전체 선택을
                    // 누르면 무슨 일이 일어날지가 체크박스 모양으로 읽혀야 한다.
                    if (el) el.indeterminate = !allVisibleChosen && visible.some((d) => selected.has(d.id));
                  }}
                  onChange={toggleAll}
                  aria-label="보이는 문서 전체 선택"
                />
                <span>
                  {chosen.length > 0 ? `${chosen.length}개 선택됨` : `${visible.length}개${filter ? " (걸러짐)" : ""}`}
                </span>
              </label>
              {chosen.length > 0 && (
                <div className="documents-toolbar-actions">
                  <button type="button" className="btn documents-action" disabled={working} onClick={() => void setScope(chosen, "shared")}>
                    모두에게 공개
                  </button>
                  <button type="button" className="btn documents-action" disabled={working} onClick={() => void setScope(chosen, "private")}>
                    나만 보기로
                  </button>
                  {/* 실패한 문서를 되살릴 때만 쓰는 버튼이 아니다. 청킹 방식이
                      바뀌면(예: 경계를 모델이 고르게 되면) 멀쩡한 문서도 다시
                      잘라야 하고, 그때 쓸 수단이 여기 말고는 없다. */}
                  <button type="button" className="btn documents-action" disabled={working} onClick={() => void retry(chosen)}>
                    다시 색인
                  </button>
                  <button type="button" className="btn btn-danger documents-action" disabled={working} onClick={() => setConfirming(chosen)}>
                    지우기
                  </button>
                </div>
              )}
            </div>

            {visibleShared.length > 0 && (
              <section className="documents-section">
                <h3 className="documents-section-title">
                  전체 공개 문서 <span className="documents-section-count">{visibleShared.length}</span>
                </h3>
                <p className="documents-section-note">
                  누가 올렸든 모든 사람의 대화에서 검색됩니다. 고치거나 지우는 것은 올린 사람만 할 수 있습니다.
                </p>
                <ul className="documents-list">
                  {visibleShared.map((doc) => (
                    <li key={`shared-${doc.ownerId}-${doc.id}`} className="documents-row" data-status={doc.status}>
                      <button
                        type="button"
                        className="documents-row-name"
                        onClick={() => setViewing(doc)}
                        title="원본 보기"
                      >
                        {doc.name}
                      </button>
                      {/* 등록자. 이름이 없으면(계정이 지워졌으면) id 만 보인다 — 지어내지 않는다. */}
                      <span className="documents-owner" title={`등록: ${doc.ownerId}`}>
                        {doc.ownerName ? `${doc.ownerName} (${doc.ownerId})` : doc.ownerId}
                      </span>
                      {doc.chunkedBy === "llm" && (
                        <span className="documents-badge" data-tone="model" title="경계를 모델이 골랐습니다">
                          모델 청킹
                        </span>
                      )}
                      <span className="documents-row-meta">
                        {formatBytes(doc.bytes)} · {doc.chunks}단락 · {formatDate(doc.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="documents-section">
              <h3 className="documents-section-title">
                내 문서 <span className="documents-section-count">{visible.length}</span>
              </h3>
              <ul className="documents-list">
              {visible.map((doc) => (
                <li
                  key={doc.id}
                  className="documents-row"
                  data-status={doc.status}
                  data-selected={selected.has(doc.id) || undefined}
                  data-busy={busy.has(doc.id) || undefined}
                >
                  <input
                    type="checkbox"
                    className="documents-row-check"
                    checked={selected.has(doc.id)}
                    onChange={() => toggle(doc.id)}
                    aria-label={`${doc.name} 선택`}
                  />
                  <button type="button" className="documents-row-name" onClick={() => setViewing(doc)} title="원본 보기">
                    {doc.name}
                  </button>
                  <span className="documents-badge" data-scope={doc.scope}>
                    {doc.scope === "shared" ? "전체 공개" : "나만"}
                  </span>
                  {doc.status === "failed" && (
                    <span className="documents-badge" data-tone="danger" title={doc.error ?? ""}>
                      색인 실패
                    </span>
                  )}
                  {doc.chunkedBy === "llm" && (
                    <span className="documents-badge" data-tone="model" title="경계를 모델이 골랐습니다">
                      모델 청킹
                    </span>
                  )}
                  <span className="documents-row-meta">
                    {formatBytes(doc.bytes)} · {doc.chunks}단락 · {formatDate(doc.createdAt)}
                  </span>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="documents-row-empty">
                  {filter.trim() ? "이름이 맞는 문서가 없습니다." : "아직 올린 문서가 없습니다."}
                </li>
              )}
              </ul>
            </section>
          </>
        )}
      </div>

      {viewing && <DocumentViewer document={viewing} onClose={() => setViewing(null)} />}

      {confirming && (
        <ConfirmDialog
          title={confirming.length === 1 ? "문서를 지울까요?" : `문서 ${confirming.length}개를 지울까요?`}
          message={`${namesOf(confirming)} 문서와 그 검색 색인을 지웁니다. 되돌릴 수 없습니다.`}
          confirmLabel="지우기"
          danger
          onConfirm={() => {
            const docs = confirming;
            setConfirming(null);
            void remove(docs);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
