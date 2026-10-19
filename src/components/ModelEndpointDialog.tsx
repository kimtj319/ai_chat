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
import { ListSkeleton, LoadFailed } from "./ListSkeleton";
import { ModelChooser } from "./ModelChooser";
import { Modal } from "./Modal";
import "./ModelEndpointDialog.css";

/**
 * A closed port burns the server's full 5s probe timeout, so this is a
 * backstop against a hung request, not the expected wait.
 */
const REQUEST_TIMEOUT_MS = 12000;

/** 이만큼까지는 고르지 않고 바로 추가한다(사내 vLLM 은 보통 1~5개). */
const SMALL_LIST = 8;

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
  const [listFailed, setListFailed] = useState(false);

  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");

  // 이 주소로 불러온 모델 목록. 주소를 바꾸면 버린다 — 다른 서버의 목록으로 고르면 안 된다.
  const [probed, setProbed] = useState<{ baseUrl: string; models: string[]; mustChoose: boolean } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  // 이미 등록된 서버의 모델 고르기(줄 아래에 펼친다).
  const [editing, setEditing] = useState<{ baseUrl: string; models: string[]; mustChoose: boolean; chosen: string[] } | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.listModelEndpoints());
      setListFailed(false);
    } catch {
      setListFailed(true);
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
      // 첫 단계: 이 서버가 무엇을 내주는지 본다. 몇 개뿐이면(예전처럼) 바로 추가하고,
      // 많으면 고르는 목록을 펼친 채 멈춘다 — 수백 개를 통째로 붙이면 모델마다 확인
      // 요청이 나가고 모델 선택란이 쓸 수 없게 된다.
      let list = probed && probed.baseUrl === normalized.baseUrl ? probed : null;
      if (!list) {
        const result = await api.probeModelEndpoint(
          { baseUrl: normalized.baseUrl, ...(apiKey.length > 0 ? { apiKey } : {}) },
          controller.signal,
        );
        list = { baseUrl: normalized.baseUrl, models: result.models, mustChoose: result.mustChoose };
        setProbed(list);
        setChosen([]);
        if (list.mustChoose || list.models.length > SMALL_LIST) {
          setStatus({ kind: "ok", text: `모델 ${list.models.length}개를 불러왔습니다. 쓸 모델을 고른 뒤 추가를 누르세요.` });
          return;
        }
      }
      if (list.mustChoose && chosen.length === 0) {
        setStatus({ kind: "error", text: endpointErrorMessage("models_required", normalized.host) });
        return;
      }

      const added = await api.addModelEndpoint(
        {
          baseUrl: normalized.baseUrl,
          ...(label.trim().length > 0 ? { label: label.trim() } : {}),
          ...(apiKey.length > 0 ? { apiKey } : {}),
          ...(chosen.length > 0 ? { models: chosen } : {}),
        },
        controller.signal,
      );
      setStatus({ kind: "ok", text: connectedMessage(added.models) });
      setAddress("");
      setLabel("");
      setApiKey("");
      setProbed(null);
      setChosen([]);
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

  async function startEditing(baseUrl: string, current: string[] | null | undefined) {
    setEditBusy(true);
    try {
      const result = await api.probeModelEndpoint({ baseUrl });
      setEditing({ baseUrl, models: result.models, mustChoose: result.mustChoose, chosen: current ?? [] });
    } catch (error) {
      const code = error instanceof ModelEndpointError ? error.code : null;
      setStatus({ kind: "error", text: endpointErrorMessage(code, "") });
    } finally {
      setEditBusy(false);
    }
  }

  async function saveEditing() {
    if (!editing) return;
    if (editing.mustChoose && editing.chosen.length === 0) {
      setStatus({ kind: "error", text: endpointErrorMessage("models_required", "") });
      return;
    }
    setEditBusy(true);
    try {
      await api.setModelEndpointModels(editing.baseUrl, editing.chosen);
      setEditing(null);
      setStatus({ kind: "ok", text: editing.chosen.length > 0 ? `모델 ${editing.chosen.length}개만 쓰도록 바꿨습니다.` : "모든 모델을 쓰도록 바꿨습니다." });
      await load();
      refreshModels();
    } catch (error) {
      const code = error instanceof ModelEndpointError ? error.code : null;
      setStatus({ kind: "error", text: endpointErrorMessage(code, "") });
    } finally {
      setEditBusy(false);
    }
  }

  async function handleDelete(baseUrl: string, host: string) {
    setPendingDelete(null);
    try {
      await api.deleteModelEndpoint(baseUrl);
      // 줄이 말없이 사라지면 눌린 것인지 알 수 없다.
      setStatus({ kind: "ok", text: `${host} 서버를 삭제했습니다.` });
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
  const deleteTarget = pendingDelete ? entries.find((entry) => entry.baseUrl === pendingDelete) : undefined;
  const deleteHost = deleteTarget ? endpointRow(deleteTarget).host : pendingDelete;
  // 주소·키를 적었거나 모델을 고르던 중이면 바깥 클릭으로는 닫지 않는다(Esc·닫기는 그대로).
  const dirty = address !== "" || label !== "" || apiKey !== "" || probed !== null || editing !== null;

  return (
    <Modal
      title="모델 서버 연동"
      // While the confirm is up, Esc and the overlay cancel *it*, not the
      // dialog underneath — both handlers then agree on the same outcome.
      onClose={pendingDelete ? () => setPendingDelete(null) : onClose}
      width={760}
      dismissOnBackdrop={!dirty}
    >
      {data && !data.privileged && (
        <p className="endpoint-scope" role="note">
          직접 등록한 서버의 모델은 나와 같은 그룹 사람들, AI Product 팀이 함께 사용합니다. 다른 그룹에는 보이지 않습니다.
        </p>
      )}

      {listFailed && <LoadFailed message="모델 서버 목록을 불러오지 못했습니다." onRetry={() => void load()} />}

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
                  className="btn btn-sm endpoint-models-button"
                  disabled={editBusy}
                  aria-expanded={editing?.baseUrl === entry.baseUrl}
                  onClick={() => (editing?.baseUrl === entry.baseUrl ? setEditing(null) : void startEditing(entry.baseUrl, entry.allowedModels))}
                >
                  모델 고르기
                </button>
              )}
              {row.removable && (
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setPendingDelete(entry.baseUrl)}
                  data-tooltip="삭제"
                  aria-label={`${row.host} 삭제`}
                >
                  <TrashIcon />
                </button>
              )}
              {editing?.baseUrl === entry.baseUrl && (
                <div className="endpoint-edit">
                  <ModelChooser
                    models={editing.models}
                    chosen={editing.chosen}
                    mustChoose={editing.mustChoose}
                    onChange={(next) => setEditing({ ...editing, chosen: next })}
                  />
                  <div className="endpoint-edit-actions">
                    <button type="button" className="btn btn-secondary" disabled={editBusy} onClick={() => setEditing(null)}>
                      취소
                    </button>
                    <button type="button" className="btn btn-primary" disabled={editBusy} onClick={() => void saveEditing()}>
                      저장
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {data && entries.length === 0 && <li className="endpoint-empty">등록된 모델 서버가 없습니다.</li>}
        {!data && !listFailed && (
          <li>
            <ListSkeleton rows={2} />
          </li>
        )}
      </ul>

      <form className="endpoint-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="endpoint-address">주소 (예: 10.0.0.10:8000)</label>
          <input
            id="endpoint-address"
            type="text"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setProbed(null);
              setChosen([]);
            }}
            placeholder="10.0.0.10:8000 또는 https://openrouter.ai/api/v1"
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
          <label htmlFor="endpoint-token">개인 키 (선택)</label>
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
            개인 키는 입력한 경우에만 전송되며, 모델 서버가 키를 요구하지 않으면 확인되지 않습니다.
          </span>
        </div>

        {probed && probed.models.length > SMALL_LIST && (
          <ModelChooser models={probed.models} chosen={chosen} mustChoose={probed.mustChoose} onChange={setChosen} />
        )}

        {/* 동작은 다른 대화상자처럼 오른쪽 끝에 서고, 결과 문구는 그 왼쪽에 붙는다. */}
        <div className="endpoint-actions">
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
          <button type="submit" className="btn btn-primary" disabled={pending || (probed !== null && probed.mustChoose && chosen.length === 0)}>
            {pending
              ? "연결을 확인하는 중…"
              : !probed
                ? "연결 확인"
                : chosen.length > 0
                  ? `모델 ${chosen.length}개로 추가`
                  : probed.mustChoose
                    ? "쓸 모델을 고르세요"
                    : "모든 모델로 추가"}
          </button>
        </div>
      </form>

      {pendingDelete && (
        <ConfirmDialog
          title={`${deleteHost} 서버를 삭제할까요?`}
          message="목록에서 빠지고, 이 모델 서버의 모델은 더 이상 고를 수 없습니다. 되돌릴 수 없습니다."
          confirmLabel="삭제"
          danger
          onConfirm={() => void handleDelete(pendingDelete, deleteHost ?? pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </Modal>
  );
}
