import { useState } from "react";
import * as api from "../api/client";
import { McpError } from "../api/client";
import type { McpHealth, McpServerSummary } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useMcpLibrary } from "../hooks/useMcpLibrary";
import {
  AUTH_MODE_LABELS,
  healthIsBad,
  healthLabel,
  hostOf,
  myLibrary,
  sharedByOthers,
  shortToolName,
  type McpServerDraft,
} from "../mcp/rules";
import { ConfirmDialog } from "./ConfirmDialog";
import { McpServerForm } from "./McpServerForm";
import "./LibraryPage.css";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function originLabel(server: McpServerSummary, owned: boolean): string {
  if (server.origin === "builtin") return "기본 제공";
  return owned ? "내가 등록" : "채택함";
}

/**
 * 대화·피커에서 이 서버를 켜고 끄는 스위치. "공유됨" 구역의 담기 체크박스와는
 * 뜻이 다르다 — 담기는 라이브러리에 들어오는 것이고, 이 스위치는 이미 들어온
 * 서버를 지금 켜 둘지를 정한다(라벨에 "대화에서 사용"을 넣어 구분한다).
 * <button role="switch"> 라서 Enter·Space 는 네이티브 클릭으로 이미 동작하고,
 * 켜짐/꺼짐은 손잡이 위치로도 구별되어 색에만 기대지 않는다.
 */
function LibrarySwitch({
  on,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className="library-switch"
      data-on={on}
      onClick={() => onToggle(!on)}
    >
      <span className="library-switch-track" aria-hidden="true">
        <span className="library-switch-thumb" />
      </span>
    </button>
  );
}

function HealthLine({ health }: { health: McpHealth }) {
  const tone = healthIsBad(health.state) ? "danger" : health.state === "ok" ? "ok" : "unknown";
  return (
    <p className="library-health" data-tone={tone}>
      <span className="library-health-dot" aria-hidden="true" />
      <span>
        {healthLabel(health.state)}
        {typeof health.toolCount === "number" && ` · 도구 ${health.toolCount}개`}
        {health.checkedAt && ` · ${formatDateTime(health.checkedAt)} 확인`}
      </span>
      {/* Unfolded, not behind a disclosure: when a server is unhealthy the
          reason is the only thing that tells you whether it is yours to fix. */}
      {health.error && <span className="library-health-error">{health.error}</span>}
    </p>
  );
}

function ServerMeta({ server }: { server: McpServerSummary }) {
  return (
    <dl className="library-meta">
      <div>
        <dt>호스트</dt>
        <dd>{server.host || hostOf(server.url)}</dd>
      </div>
      <div>
        <dt>전송</dt>
        <dd>{server.transport || "-"}</dd>
      </div>
      <div>
        <dt>인증</dt>
        <dd>
          {AUTH_MODE_LABELS[server.authMode] ?? server.authMode}
          {server.authHeaderName ? ` (${server.authHeaderName})` : ""}
        </dd>
      </div>
      <div>
        <dt>도구</dt>
        <dd>{server.tools.length}개</dd>
      </div>
    </dl>
  );
}

interface LibraryCardProps {
  server: McpServerSummary;
  /** True when the signed-in user registered it themselves. */
  owned: boolean;
  /** !hidden — whether this server's tools are on in the picker and the prompt. */
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onProbe: () => void;
  /** Takes it out of this user's library entirely (un-adopts it). Null for a
   *  builtin or a server this user registered — for those, the switch above
   *  is the only on/off there is; there is no "out of the library" for them. */
  onRemove: (() => void) | null;
  onSaveCredential: (credential: string | null) => void;
  /** Null for everyone who is not an administrator. */
  onAdminSetStatus: ((disabled: boolean) => void) | null;
}

function LibraryCard({
  server,
  owned,
  enabled,
  onToggleEnabled,
  busy,
  onEdit,
  onDelete,
  onProbe,
  onRemove,
  onSaveCredential,
  onAdminSetStatus,
}: LibraryCardProps) {
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [credential, setCredential] = useState("");
  const needsCredential = server.requiresCredential && !server.hasCredential;

  return (
    <li className="library-card">
      <div className="library-card-head">
        <h3 className="library-card-name">{server.name}</h3>
        <span className="library-badge" data-origin={server.origin}>
          {originLabel(server, owned)}
        </span>
        {server.status === "disabled" && (
          <span className="library-badge" data-tone="danger">
            관리자 비활성화
          </span>
        )}
        <LibrarySwitch
          on={enabled}
          disabled={busy}
          label={`${server.name} 대화에서 사용`}
          onToggle={onToggleEnabled}
        />
      </div>

      <p className="library-card-description">{server.description}</p>
      <ServerMeta server={server} />
      <HealthLine health={server.health} />

      {needsCredential && (
        <p className="library-warning">이 서버는 개인 자격 증명이 필요합니다. 입력하기 전에는 도구가 실행되지 않습니다.</p>
      )}

      {server.tools.length > 0 && (
        <ul className="library-tool-chips">
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <code data-tooltip={tool.description}>{shortToolName(tool.name)}</code>
            </li>
          ))}
        </ul>
      )}

      {credentialOpen && (
        <div className="library-credential">
          <input
            type="password"
            autoComplete="off"
            aria-label={`${server.name} 자격 증명`}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary library-action"
            disabled={busy || credential.trim().length === 0}
            onClick={() => {
              onSaveCredential(credential.trim());
              setCredential("");
              setCredentialOpen(false);
            }}
          >
            저장
          </button>
          {server.hasCredential && (
            <button
              type="button"
              className="btn btn-danger library-action"
              disabled={busy}
              onClick={() => {
                onSaveCredential(null);
                setCredential("");
                setCredentialOpen(false);
              }}
            >
              지우기
            </button>
          )}
        </div>
      )}

      <div className="library-actions">
        <button type="button" className="btn library-action" disabled={busy} onClick={onProbe}>
          연결 확인
        </button>
        {server.authMode === "header" && (
          <button
            type="button"
            className="btn library-action"
            disabled={busy}
            onClick={() => setCredentialOpen((open) => !open)}
          >
            {server.hasCredential ? "자격 증명 변경" : "자격 증명 입력"}
          </button>
        )}
        {owned && (
          <button type="button" className="btn library-action" disabled={busy} onClick={onEdit}>
            수정
          </button>
        )}
        {onRemove && (
          <button type="button" className="btn btn-secondary library-action" disabled={busy} onClick={onRemove}>
            채택 해제
          </button>
        )}
        {owned && (
          <button type="button" className="btn btn-danger library-action" disabled={busy} onClick={onDelete}>
            삭제
          </button>
        )}
        {onAdminSetStatus && (
          <button
            type="button"
            className="btn library-action"
            disabled={busy}
            onClick={() => onAdminSetStatus(server.status !== "disabled")}
          >
            {server.status === "disabled" ? "다시 활성화" : "비활성화"}
          </button>
        )}
      </div>
    </li>
  );
}

interface SharedCardProps {
  server: McpServerSummary;
  adopted: boolean;
  busy: boolean;
  onToggleAdoption: (adopted: boolean) => void;
  onAdminSetStatus: ((disabled: boolean) => void) | null;
}

function SharedCard({ server, adopted, busy, onToggleAdoption, onAdminSetStatus }: SharedCardProps) {
  return (
    <li className="library-shared-card">
      <label className="library-adopt">
        <input
          type="checkbox"
          checked={adopted}
          disabled={busy}
          onChange={(event) => onToggleAdoption(event.target.checked)}
        />
        <span className="visually-hidden">{server.name} 채택</span>
      </label>

      <div className="library-shared-body">
        <div className="library-card-head">
          <h3 className="library-card-name">{server.name}</h3>
          {adopted && <span className="library-badge">내 라이브러리에 있음</span>}
          {server.status === "disabled" && (
            <span className="library-badge" data-tone="danger">
              관리자 비활성화
            </span>
          )}
        </div>

        <p className="library-card-description">{server.description}</p>
        <p className="library-shared-by">
          {server.createdBy} 님이 {formatDateTime(server.createdAt)}에 등록 · {server.adoptedCount}명이 채택
        </p>

        <ServerMeta server={server} />
        <HealthLine health={server.health} />

        {server.requiresCredential && (
          <p className="library-warning">채택한 뒤 내 자격 증명을 따로 입력해야 실행됩니다.</p>
        )}

        {/* Full descriptions, unfolded. A tool's description sits in the prompt
            of every conversation it is switched on in — called or not — so the
            box cannot be ticked without seeing what is being taken on. */}
        <p className="library-tool-heading">
          도구 {server.tools.length}개 — 켜면 아래 설명이 대화 프롬프트에 그대로 들어갑니다.
        </p>
        {server.tools.length === 0 ? (
          <p className="library-empty-inline">아직 도구 목록을 가져오지 못했습니다.</p>
        ) : (
          <ul className="library-tool-list">
            {server.tools.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>
                <p>{tool.description}</p>
              </li>
            ))}
          </ul>
        )}

        {onAdminSetStatus && (
          <div className="library-actions">
            <button
              type="button"
              className="btn library-action"
              disabled={busy}
              onClick={() => onAdminSetStatus(server.status !== "disabled")}
            >
              {server.status === "disabled" ? "다시 활성화" : "비활성화"}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

interface LibraryPageProps {
  onBack: () => void;
  /** Null for everyone who is not an administrator: the control is then never
   *  rendered, rather than the card deciding from a role. */
  onAdminSetStatus: ((id: string, disabled: boolean) => Promise<void>) | null;
}

/** A 409 on a delete is not a failure to report verbatim — it means someone
 *  else is relying on the server. */
function failureMessage(error: unknown): string {
  if (error instanceof McpError && error.status === 409) {
    return error.adoptedCount === null
      ? "다른 사용자가 채택 중이라 삭제할 수 없습니다."
      : `다른 사용자 ${error.adoptedCount}명이 채택 중이라 삭제할 수 없습니다.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function LibraryPage({ onBack, onAdminSetStatus }: LibraryPageProps) {
  const { me } = useAuth();
  const meId = me?.id ?? "";
  const { servers, adopted, hidden, loading, unavailable, error, reload } = useMcpLibrary();

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<McpServerSummary | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServerSummary | null>(null);

  /** Every write goes through here so one failure path serves them all. */
  async function run(id: string, doneMessage: string, work: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(doneMessage);
      await reload();
      return true;
    } catch (err) {
      setActionError(failureMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function submitDraft(draft: McpServerDraft): Promise<void> {
    const editing = formFor !== "new" && formFor !== null ? formFor : null;
    const body = {
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      description: draft.description.trim(),
      url: draft.url.trim(),
      authMode: draft.authMode,
      ...(draft.authMode === "header" ? { authHeaderName: draft.authHeaderName.trim() } : {}),
      // An edit that leaves the field blank keeps whatever is stored.
      ...(draft.credential.trim().length > 0 ? { credential: draft.credential.trim() } : {}),
    };

    // Deliberately not inside `run`: the form shows the refusal itself (it is
    // the only place that can point at the field that caused it) and stays open.
    if (editing) await api.updateMcpServer(editing.id, body);
    else await api.createMcpServer(body);

    setFormFor(null);
    setNotice(editing ? `${body.name} 서버를 수정했습니다.` : `${body.name} 서버를 등록했습니다.`);
    await reload();
  }

  const mine = myLibrary(servers, adopted, meId);
  const shared = sharedByOthers(servers, meId);
  const adoptedIds = new Set(adopted);
  const hiddenIds = new Set(hidden);

  return (
    <div className="library-page">
      <header className="library-header">
        <button type="button" className="btn-icon" onClick={onBack} data-tooltip="채팅으로 돌아가기" aria-label="채팅으로 돌아가기">
          <BackIcon />
        </button>
        <div className="library-header-text">
          <h1 className="library-title">라이브러리</h1>
          <p className="library-subtitle">
            {loading ? "불러오는 중…" : `내 라이브러리 ${mine.length}개 · 공유됨 ${shared.length}개`}
          </p>
        </div>
        <button type="button" className="btn-icon" onClick={() => void reload()} data-tooltip="새로고침" aria-label="새로고침">
          <RefreshIcon />
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setFormFor("new")} disabled={unavailable}>
          서버 등록
        </button>
      </header>

      <div className="library-body">
        {notice && (
          <p className="library-notice" role="status">
            {notice}
          </p>
        )}
        {(actionError || error) && (
          <p className="library-error" role="alert">
            {actionError ?? error}
          </p>
        )}
        {unavailable && (
          <p className="library-notice" role="status">
            이 서버에는 아직 MCP 기능이 배포되지 않았습니다. 배포되면 등록한 서버가 여기에 표시됩니다.
          </p>
        )}

        <section className="library-section">
          <h2 className="library-section-title">내 라이브러리</h2>
          <p className="library-section-hint">
            기본 제공 서버와 내가 등록하거나 채택한 서버입니다. 이 중 스위치를 켠 서버만 채팅 입력창의 MCP
            도구 선택(+)에 나타나고, 모델에게도 그 서버의 도구가 전달됩니다.
          </p>

          {loading ? (
            <p className="library-empty">불러오는 중…</p>
          ) : mine.length === 0 ? (
            <p className="library-empty">라이브러리가 비어 있습니다. 서버를 등록하거나 아래에서 공유된 서버를 채택해보세요.</p>
          ) : (
            <ul className="library-card-list">
              {mine.map((server) => {
                const owned = server.origin === "user" && server.createdBy === meId;
                // 채택 해제는 남이 등록한 서버를 라이브러리 밖으로 완전히 빼는
                // 조작이다 — 기본 제공이나 내가 등록한 서버에는 뜻이 없다(둘 다
                // adopted 와 무관하게 항상 멤버라 채택 해제해도 그대로 남는다).
                // 그런 경우 끄고 켜는 일은 위 스위치 하나로 충분하다.
                const canUnadopt = server.origin !== "builtin" && !owned;
                return (
                <LibraryCard
                  key={server.id}
                  server={server}
                  owned={owned}
                  enabled={!hiddenIds.has(server.id)}
                  onToggleEnabled={(next) =>
                    void run(server.id, next ? `${server.name} 서버를 켰습니다.` : `${server.name} 서버를 껐습니다.`, () =>
                      api.setMcpHidden(server.id, !next),
                    )
                  }
                  busy={busyId === server.id}
                  onEdit={() => setFormFor(server)}
                  onDelete={() => setPendingDelete(server)}
                  onProbe={() =>
                    void run(server.id, `${server.name} 연결을 확인했습니다.`, async () => {
                      const { health } = await api.probeMcpServer(server.id);
                      if (healthIsBad(health.state)) {
                        throw new Error(health.error ?? `${server.name} 연결 상태: ${healthLabel(health.state)}`);
                      }
                    })
                  }
                  onRemove={
                    canUnadopt
                      ? () =>
                          void run(server.id, `${server.name} 서버를 라이브러리에서 뺐습니다.`, () =>
                            api.setMcpAdoption(server.id, false),
                          )
                      : null
                  }
                  onSaveCredential={(credential) =>
                    void run(
                      server.id,
                      credential === null ? "자격 증명을 지웠습니다." : "자격 증명을 저장했습니다.",
                      () => api.setMcpCredential(server.id, credential),
                    )
                  }
                  onAdminSetStatus={
                    onAdminSetStatus
                      ? (disabled) =>
                          void run(server.id, disabled ? `${server.name} 서버를 비활성화했습니다.` : `${server.name} 서버를 활성화했습니다.`, () =>
                            onAdminSetStatus(server.id, disabled),
                          )
                      : null
                  }
                />
                );
              })}
            </ul>
          )}
        </section>

        <section className="library-section">
          <h2 className="library-section-title">다른 사용자가 공유하는 라이브러리</h2>
          <p className="library-section-hint">
            체크하면 내 라이브러리에 추가됩니다. 체크하기 전에는 내 대화에서 어떤 것도 실행되지 않습니다.
          </p>

          {loading ? (
            <p className="library-empty">불러오는 중…</p>
          ) : shared.length === 0 ? (
            <p className="library-empty">다른 사용자가 공유한 서버가 없습니다.</p>
          ) : (
            <ul className="library-card-list">
              {shared.map((server) => (
                <SharedCard
                  key={server.id}
                  server={server}
                  adopted={adoptedIds.has(server.id)}
                  busy={busyId === server.id}
                  onToggleAdoption={(next) =>
                    void run(
                      server.id,
                      next ? `${server.name} 서버를 내 라이브러리에 추가했습니다.` : `${server.name} 서버를 뺐습니다.`,
                      () => api.setMcpAdoption(server.id, next),
                    )
                  }
                  onAdminSetStatus={
                    onAdminSetStatus
                      ? (disabled) =>
                          void run(server.id, disabled ? `${server.name} 서버를 비활성화했습니다.` : `${server.name} 서버를 활성화했습니다.`, () =>
                            onAdminSetStatus(server.id, disabled),
                          )
                      : null
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {formFor && (
        <McpServerForm
          server={formFor === "new" ? null : formFor}
          onSubmit={submitDraft}
          onClose={() => setFormFor(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="MCP 서버 삭제"
          message={`"${pendingDelete.name}" 서버를 삭제하시겠습니까? 이 서버를 채택한 다른 사용자의 라이브러리에서도 사라집니다.`}
          confirmLabel="삭제"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void run(target.id, `${target.name} 서버를 삭제했습니다.`, () => api.deleteMcpServer(target.id));
          }}
        />
      )}
    </div>
  );
}
