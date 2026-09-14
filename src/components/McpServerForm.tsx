import { useState, type FormEvent } from "react";
import type { McpAuthMode, McpServerSummary } from "../api/types";
import { hasErrors, hostOf, validateDraft, type McpDraftErrors, type McpServerDraft } from "../mcp/rules";
import { Modal } from "./Modal";

interface McpServerFormProps {
  /** The server being edited, or null when registering a new one. */
  server: McpServerSummary | null;
  /** Rejects with the server's own Korean message when the probe fails. */
  onSubmit: (draft: McpServerDraft) => Promise<void>;
  onClose: () => void;
}

const AUTH_MODES: Array<{ value: McpAuthMode; label: string }> = [
  { value: "none", label: "인증 없음" },
  { value: "header", label: "헤더로 자격 증명 전송" },
];

function draftFrom(server: McpServerSummary | null): McpServerDraft {
  return {
    name: server?.name ?? "",
    slug: server?.slug ?? "",
    description: server?.description ?? "",
    url: server?.url ?? "",
    authMode: server?.authMode ?? "none",
    authHeaderName: server?.authHeaderName ?? "",
    credential: "",
  };
}

export function McpServerForm({ server, onSubmit, onClose }: McpServerFormProps) {
  const editing = server !== null;
  const [draft, setDraft] = useState<McpServerDraft>(() => draftFrom(server));
  const [errors, setErrors] = useState<McpDraftErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof McpServerDraft>(key: K, value: McpServerDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validateDraft(draft, server?.hasCredential ?? false);
    setErrors(found);
    if (hasErrors(found)) return;

    setBusy(true);
    setServerError(null);
    try {
      await onSubmit(draft);
    } catch (error) {
      // The registration probe is the server's job: it is the only thing that
      // knows whether the URL actually speaks MCP, and its refusal is already
      // written in Korean.
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? "MCP 서버 수정" : "MCP 서버 등록"} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="mcp-name">이름</label>
          <input
            id="mcp-name"
            type="text"
            value={draft.name}
            autoFocus
            onChange={(event) => set("name", event.target.value)}
          />
          {errors.name && <span className="mcp-form-error">{errors.name}</span>}
        </div>

        <div className="field">
          <label htmlFor="mcp-slug">슬러그</label>
          <input
            id="mcp-slug"
            type="text"
            value={draft.slug}
            /* Locked once registered: every conversation stores its tools as
               `mcp__{slug}__{tool}`, so renaming the slug would silently switch
               off every tool anyone had enabled. */
            readOnly={editing}
            onChange={(event) => set("slug", event.target.value)}
          />
          <span className="field-hint">
            {editing
              ? "등록 후에는 바꿀 수 없습니다. 대화에 저장된 도구 이름이 이 값을 포함합니다."
              : `도구 이름이 mcp__${draft.slug.trim() || "slug"}__도구이름 형태로 만들어집니다.`}
          </span>
          {errors.slug && <span className="mcp-form-error">{errors.slug}</span>}
        </div>

        <div className="field">
          <label htmlFor="mcp-description">설명</label>
          <textarea
            id="mcp-description"
            rows={2}
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
          />
          {errors.description && <span className="mcp-form-error">{errors.description}</span>}
        </div>

        <div className="field">
          <label htmlFor="mcp-url">주소</label>
          <input
            id="mcp-url"
            type="text"
            placeholder="https://example.com/mcp"
            value={draft.url}
            onChange={(event) => set("url", event.target.value)}
          />
          <span className="field-hint">
            요청은 {hostOf(draft.url.trim()) || "…"} 으로 나갑니다. 이 서버를 채택한 모든 사용자의 대화 내용이 이 호스트로
            전달됩니다.
          </span>
          {errors.url && <span className="mcp-form-error">{errors.url}</span>}
        </div>

        <div className="field">
          <label htmlFor="mcp-auth">인증</label>
          <select
            id="mcp-auth"
            value={draft.authMode}
            onChange={(event) => set("authMode", event.target.value as McpAuthMode)}
          >
            {AUTH_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>

        {draft.authMode === "header" && (
          <>
            <div className="field">
              <label htmlFor="mcp-header">헤더 이름</label>
              <input
                id="mcp-header"
                type="text"
                placeholder="Authorization"
                value={draft.authHeaderName}
                onChange={(event) => set("authHeaderName", event.target.value)}
              />
              {errors.authHeaderName && <span className="mcp-form-error">{errors.authHeaderName}</span>}
            </div>

            <div className="field">
              <label htmlFor="mcp-credential">자격 증명</label>
              <input
                id="mcp-credential"
                type="password"
                autoComplete="off"
                value={draft.credential}
                onChange={(event) => set("credential", event.target.value)}
              />
              <span className="field-hint">
                {server?.hasCredential
                  ? "비워두면 저장된 값을 그대로 둡니다."
                  : "서버에 저장되며 다시 보이지 않습니다."}
              </span>
              {errors.credential && <span className="mcp-form-error">{errors.credential}</span>}
            </div>
          </>
        )}

        {serverError && (
          <p className="mcp-form-server-error" role="alert">
            {serverError}
          </p>
        )}

        <div className="mcp-form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "확인 중…" : editing ? "저장" : "등록"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
