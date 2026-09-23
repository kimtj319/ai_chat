import { useEffect, useMemo, useState } from "react";
import {
  consolidateProhibitions,
  getProhibitions,
  saveProhibitions,
  type ProhibitionsResponse,
} from "../api/client";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import "./ProhibitionsDialog.css";

/**
 * 내 "하지 말 것" 목록을 보고 고친다. 파일 하나(markdown)를 그대로 편집하는 창이다.
 *
 * 경계 줄 `## 검토 대기` 위는 모든 대화에 반영되고, 아래는 대화에서 자동으로 찾아
 * 모아 둔 후보라 반영되지 않는다. 규칙은 서버(storage/prohibitionsStore.ts)가 정하고,
 * 여기의 splitAt / activeLength 는 글자 수를 입력하는 대로 보여 주려고 같은 규칙을
 * 흉내 낼 뿐이다 — 저장하면 서버가 센 값으로 바뀐다.
 */

const PENDING_LINE = /^##\s*검토\s*대기\s*$/m;
const LIST_LINE = /^\s*([-*]|\d+\.)\s+\S/;

function splitAt(md: string): { active: string; pendingHeading: string; pending: string } {
  const m = PENDING_LINE.exec(md);
  if (!m) return { active: md, pendingHeading: "", pending: "" };
  return { active: md.slice(0, m.index), pendingHeading: m[0], pending: md.slice(m.index + m[0].length) };
}

function activeLength(md: string): number {
  return splitAt(md)
    .active.replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^#\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim().length;
}

function pendingLines(md: string): string[] {
  return splitAt(md).pending.split("\n").filter((line) => LIST_LINE.test(line));
}

/** 반영 부분에서 목록이 시작하기 전까지(제목·설명 주석). 정리안으로 바꿀 때 남긴다. */
function headerOf(active: string): string {
  const lines = active.split("\n");
  const first = lines.findIndex((line) => LIST_LINE.test(line));
  return (first < 0 ? lines : lines.slice(0, first)).join("\n").trimEnd();
}

export function ProhibitionsDialog({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<ProhibitionsResponse | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "consolidate" | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    let alive = true;
    getProhibitions()
      .then((res) => {
        if (!alive) return;
        setLoaded(res);
        setText(res.markdown);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, []);

  const dirty = loaded !== null && text !== loaded.markdown;
  const chars = useMemo(() => activeLength(text), [text]);
  const pending = useMemo(() => pendingLines(text), [text]);
  const limit = loaded?.limitChars ?? 4000;
  const ratio = chars / limit;
  const level = ratio > 1 ? "over" : ratio >= (loaded?.warnRatio ?? 0.7) ? "warn" : "ok";

  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  async function save() {
    setBusy("save");
    setError(null);
    setStatus(null);
    try {
      const res = await saveProhibitions(text);
      setLoaded(res);
      setText(res.markdown);
      setStatus("저장했습니다. 다음 메시지부터 반영됩니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** 검토 대기 항목을 전부 경계 위로 올린다. 저장은 사용자가 따로 누른다. */
  function acceptAllPending() {
    const { active, pendingHeading, pending: rest } = splitAt(text);
    const moving = rest.split("\n").filter((line) => LIST_LINE.test(line));
    const staying = rest.split("\n").filter((line) => !LIST_LINE.test(line)).join("\n").trim();
    setText(`${active.trimEnd()}\n${moving.join("\n")}\n\n${pendingHeading}\n${staying ? `${staying}\n` : ""}`);
    setStatus(null);
  }

  async function consolidate() {
    if (dirty) {
      setError("정리는 저장된 목록을 기준으로 합니다. 먼저 저장하세요.");
      return;
    }
    setBusy("consolidate");
    setError(null);
    setStatus(null);
    try {
      const res = await consolidateProhibitions();
      setProposal(res.proposal);
      setStatus(`${res.before}개 항목을 ${res.after}개로 묶는 안입니다. 확인하고 적용하세요.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function applyProposal() {
    if (!proposal) return;
    const { active, pendingHeading, pending: rest } = splitAt(text);
    const header = headerOf(active);
    setText(`${header ? `${header}\n\n` : ""}${proposal}\n\n${pendingHeading || "## 검토 대기"}${rest.replace(/\s*$/, "\n")}`);
    setProposal(null);
    setStatus("정리안을 적용했습니다. 저장해야 반영됩니다.");
  }

  return (
    <Modal title="하지 말 것 목록" onClose={requestClose} size="wide">
      <p className="proh-intro">
        적어 둔 것은 내 <strong>모든 대화</strong>에 반영됩니다. <code>## 검토 대기</code> 아래는 대화 중 &ldquo;하지
        말라&rdquo; 는 뜻으로 읽힌 말을 자동으로 모아 둔 후보로, 위로 옮기기 전까지는 반영되지 않습니다.
      </p>

      {loaded === null && !error && <p className="proh-note">불러오는 중…</p>}

      {loaded !== null && (
        <>
          <div className="proh-toolbar">
            <span className={`proh-meter proh-meter-${level}`} aria-live="polite">
              반영 {chars.toLocaleString()} / {limit.toLocaleString()}자
              {level === "over" && " · 넘친 뒷부분은 반영되지 않습니다"}
            </span>
            <span className="proh-toolbar-actions">
              {pending.length > 0 && (
                <button type="button" className="btn btn-secondary" onClick={acceptAllPending}>
                  검토 대기 {pending.length}건 모두 반영
                </button>
              )}
              <button
                type="button"
                className={`btn ${level === "ok" ? "btn-secondary" : "btn-primary"}`}
                onClick={() => void consolidate()}
                disabled={busy !== null}
                data-tooltip="비슷한 항목을 묶어 줄인 안을 만듭니다. 바로 저장하지는 않습니다."
              >
                {busy === "consolidate" ? "정리하는 중…" : "비슷한 항목 묶기"}
              </button>
            </span>
          </div>

          <label className="proh-label" htmlFor="prohibitions-editor">
            목록 (markdown · 한 줄에 하나씩 &ldquo;- &rdquo; 로 시작)
          </label>
          <textarea
            id="prohibitions-editor"
            className="proh-editor"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setStatus(null);
            }}
            spellCheck={false}
            rows={16}
          />

          {proposal && (
            <div className="proh-proposal" role="region" aria-label="정리안">
              <p className="proh-proposal-title">정리안 — 반영 부분만 바뀌고 검토 대기는 그대로 둡니다</p>
              <pre className="proh-proposal-body">{proposal}</pre>
              <div className="proh-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setProposal(null)}>
                  버리기
                </button>
                <button type="button" className="btn btn-primary" onClick={applyProposal}>
                  편집기에 적용
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="proh-error" role="alert">
          {error}
        </p>
      )}
      {status && !error && (
        <p className="proh-status" role="status">
          {status}
        </p>
      )}

      <div className="proh-actions">
        <button type="button" className="btn btn-secondary" onClick={requestClose}>
          닫기
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || busy !== null}>
          {busy === "save" ? "저장하는 중…" : "저장"}
        </button>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="저장하지 않은 변경"
          message="고친 내용을 저장하지 않고 닫을까요?"
          confirmLabel="저장하지 않고 닫기"
          danger
          onConfirm={onClose}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </Modal>
  );
}
