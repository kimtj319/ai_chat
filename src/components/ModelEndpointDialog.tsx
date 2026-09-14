import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as api from "../api/client";
import { ModelEndpointError } from "../api/client";
import type { ModelEndpointsResponse } from "../api/types";
import { refreshModels } from "../hooks/useModels";
import {
  connectedMessage,
  endpointErrorMessage,
  endpointRow,
  normalizeEndpointInput,
} from "../state/modelEndpoints";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import "./ModelEndpointDialog.css";

/**
 * A closed port burns the server's full 5s probe timeout, so this is a
 * backstop against a hung request, not the expected wait.
 */
const REQUEST_TIMEOUT_MS = 12000;

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string };

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

interface ModelEndpointDialogProps {
  onClose: () => void;
}

/** The 모델 연동 dialog: what is configured now, and a form to add one more. */
export function ModelEndpointDialog({ onClose }: ModelEndpointDialogProps) {
  const [data, setData] = useState<ModelEndpointsResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [adminToken, setAdminToken] = useState("");

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.listModelEndpoints());
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (status.kind === "pending") return;

    const normalized = normalizeEndpointInput(address);
    if (!normalized.ok) {
      setStatus({ kind: "error", text: endpointErrorMessage("invalid_url", "") });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setStatus({ kind: "pending" });

    try {
      const added = await api.addModelEndpoint(
        {
          baseUrl: normalized.baseUrl,
          ...(label.trim().length > 0 ? { label: label.trim() } : {}),
          ...(apiKey.length > 0 ? { apiKey } : {}),
        },
        adminToken,
        controller.signal,
      );
      setStatus({ kind: "ok", text: connectedMessage(added.models) });
      setAddress("");
      setLabel("");
      setApiKey("");
      await load();
      // The whole point is that the new model is usable straight away.
      refreshModels();
    } catch (error) {
      if (controller.signal.aborted) {
        setStatus({ kind: "error", text: endpointErrorMessage("unreachable", normalized.host) });
      } else {
        const code = error instanceof ModelEndpointError ? error.code : null;
        setStatus({ kind: "error", text: endpointErrorMessage(code, normalized.host) });
      }
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
    }
  }

  async function handleDelete(baseUrl: string) {
    setPendingDelete(null);
    try {
      await api.deleteModelEndpoint(baseUrl, adminToken);
      await load();
      refreshModels();
    } catch (error) {
      const code = error instanceof ModelEndpointError ? error.code : null;
      setStatus({ kind: "error", text: endpointErrorMessage(code, "") });
    }
  }

  // Keyed by baseUrl, not by the displayed host: two entries can differ only
  // in a "/v1" suffix, which the display form deliberately strips.
  const entries = data?.endpoints ?? [];
  const pending = status.kind === "pending";

  return (
    <Modal
      title="서빙 서버 연동"
      // While the confirm is up, Esc and the overlay cancel *it*, not the
      // dialog underneath — both handlers then agree on the same outcome.
      onClose={pendingDelete ? () => setPendingDelete(null) : onClose}
      width={560}
    >
      {data?.unprotected && (
        <p className="endpoint-warning" role="status">
          이 서버는 접근 제어가 설정되어 있지 않습니다. 신뢰할 수 있는 망에서만 사용하세요.
        </p>
      )}

      {listError && <p className="message-error">{listError}</p>}

      <ul className="endpoint-list">
        {entries.map((entry) => {
          const row = endpointRow(entry);
          return (
            <li key={entry.baseUrl} className="endpoint-row">
              <div className="endpoint-row-text">
                <span className="endpoint-row-label">{row.label}</span>
                <span className="endpoint-row-host">{row.host}</span>
                <span className="endpoint-row-models">{row.models}</span>
                {row.sourceNote && <span className="endpoint-row-note">{row.sourceNote}</span>}
              </div>
              <span className="endpoint-row-status" data-reachable={row.reachable ? "true" : "false"}>
                {row.statusText}
              </span>
              {row.removable && (
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setPendingDelete(entry.baseUrl)}
                  data-tooltip="제거"
                  aria-label={`${row.host} 제거`}
                >
                  <TrashIcon />
                </button>
              )}
            </li>
          );
        })}
        {data && entries.length === 0 && <li className="endpoint-empty">등록된 서버가 없습니다.</li>}
        {!data && !listError && <li className="endpoint-empty">불러오는 중…</li>}
      </ul>

      <form className="endpoint-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="endpoint-address">주소 (예: 10.0.0.10:8000)</label>
          <input
            id="endpoint-address"
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="10.0.0.10:8000"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="endpoint-label">이름 (선택)</label>
          <input
            id="endpoint-label"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="endpoint-token">토큰 (선택)</label>
          <input
            id="endpoint-token"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
          />
          {/* These servers answer 200 to a wrong token, so a "확인됨" here
              would be a lie. Say exactly what the field does. */}
          <span className="field-hint">
            토큰은 입력한 경우에만 전송되며, 서버가 토큰을 요구하지 않으면 확인되지 않습니다.
          </span>
        </div>

        {/* Only when the server actually has an admin token configured —
            otherwise the field would ask for something that does not exist. */}
        {data && !data.unprotected && (
          <div className="field">
            <label htmlFor="endpoint-admin">관리 토큰</label>
            <input
              id="endpoint-admin"
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              autoComplete="new-password"
            />
          </div>
        )}

        <div className="endpoint-actions">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "연결을 확인하는 중…" : "연결 확인 후 추가"}
          </button>
          {status.kind !== "idle" && status.kind !== "pending" && (
            <p className="endpoint-status" role="status" data-tone={status.kind === "ok" ? "ok" : "danger"}>
              {status.text}
            </p>
          )}
          {pending && (
            <p className="endpoint-status" role="status" data-tone="pending">
              연결을 확인하는 중…
            </p>
          )}
        </div>
      </form>

      {pendingDelete && (
        <ConfirmDialog
          title="서버 제거"
          message="이 서버를 목록에서 제거할까요?"
          confirmLabel="제거"
          danger
          onConfirm={() => void handleDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </Modal>
  );
}
