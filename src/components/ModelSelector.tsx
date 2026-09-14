import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { showToast } from "./Toast";
import { pushOverlay } from "../ui/overlayStack";
import { useModels } from "../hooks/useModels";
import { resolveSelectedModelId } from "../state/modelCatalog";
import {
  capabilityOf,
  kindMismatchReason,
  kindOf,
  listableModels,
  modelAvailability,
} from "../state/modelCapability";
import { useStore, useActiveConversation } from "../state/StoreContext";
import "./ModelSelector.css";

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** True for an all-caps alphanumeric quantization/format tag such as "FP8" or "INT4". */
function isFormatTag(token: string): boolean {
  return /^[A-Z0-9]{2,8}$/.test(token) && /\d/.test(token);
}

/**
 * Derive a short, readable label from a raw HF model id — e.g.
 * "huihui-ai/Huihui-Qwen3.8-27B-abliterated" -> "Qwen3.8-27B (abliterated)"
 * "Qwen/Qwen3.8-Flash-Next-FP8" -> "Qwen3.8-Flash-Next FP8"
 * Strips the HF org, drops a leading vendor tag ahead of the "Qwen..." name,
 * then folds a trailing lowercase qualifier into parens or a trailing
 * all-caps format tag into a plain suffix.
 */
export function shortModelName(id: string): string {
  const base = id.split("/").pop() ?? id;
  const parts = base.split("-").filter(Boolean);
  const qwenIndex = parts.findIndex((part) => /^qwen/i.test(part));
  const trimmed = qwenIndex > 0 ? parts.slice(qwenIndex) : parts;
  if (trimmed.length <= 1) return trimmed.join("-") || base;

  const last = trimmed[trimmed.length - 1] ?? "";
  const head = trimmed.slice(0, -1).join("-");
  if (isFormatTag(last)) return `${head} ${last}`;
  if (/^[a-z]+$/.test(last)) return `${head} (${last})`;
  return trimmed.join("-");
}

/** The composer's reasoning popover, mirrored here: a text trigger that opens
 * a small listbox of every model in the catalog. The model is a per-
 * conversation field on the backend — selecting one PATCHes the open
 * conversation, or (when none is open) sets the default for the next one
 * created. */
export function ModelSelector() {
  const { catalog, current, loading, error } = useModels();
  const { updateModel, ui, setLastModel } = useStore();
  const { activeConversation } = useActiveConversation();
  const [open, setOpen] = useState(false);

  // 열려 있는 동안은 Esc 가 이쪽 몫이다 — 전역 Esc(생성 중단)와 겹치지 않게.
  useEffect(() => (open ? pushOverlay() : undefined), [open]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (loading) {
    return (
      <div className="model-switcher">
        <span className="model-switcher-trigger model-switcher-trigger-muted">모델 불러오는 중…</span>
      </div>
    );
  }
  if (error || catalog.length === 0) {
    return (
      <div className="model-switcher">
        <span className="model-switcher-trigger model-switcher-trigger-muted">모델 정보 없음</span>
      </div>
    );
  }

  const selectedId = resolveSelectedModelId(catalog, current, activeConversation?.model ?? null, ui.lastModel);
  const selectedLabel = shortModelName(selectedId);

  // A conversation is locked to one kind by its *first message*, so an empty
  // conversation can still switch freely between chat and embedding models.
  const lockedKind =
    activeConversation && activeConversation.messages.length > 0 ? kindOf(activeConversation.kind) : null;
  // "unusable" models are served but not usable from here, so they are not
  // offered at all — a row that can never do anything is just noise.
  const options = listableModels(catalog);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      setOpen(true);
    }
  }

  async function handleSelect(id: string) {
    setOpen(false);
    if (id === selectedId) return;
    if (!activeConversation) {
      setLastModel(id);
      return;
    }
    try {
      await updateModel(id);
    } catch (err) {
      // The server refuses a model whose capability does not match a
      // conversation that is already locked. Say what to do about it (start a
      // new conversation) rather than surfacing the raw refusal.
      const entry = catalog.find((candidate) => candidate.id === id);
      const message =
        lockedKind !== null
          ? kindMismatchReason(lockedKind, capabilityOf(entry))
          : err instanceof Error
            ? err.message
            : String(err);
      // 모델을 바꿀 수 없는 이유는 사람이 읽고 판단할 내용이라 오래 머문다.
      showToast(message, "error");
    }
  }

  return (
    <div className="model-switcher" ref={containerRef}>
      <button
        type="button"
        className="model-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="model-switcher-trigger-label">{selectedLabel}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="model-switcher-popover" role="listbox" aria-label="모델 선택">
          {options.map((entry) => {
            const availability = modelAvailability(entry, lockedKind);
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={entry.id === selectedId}
                aria-disabled={availability.selectable ? undefined : true}
                disabled={!availability.selectable}
                title={availability.reason ?? shortModelName(entry.id)}
                className={`model-switcher-option${entry.id === selectedId ? " active" : ""}${
                  availability.selectable ? "" : " unavailable"
                }`}
                onClick={() => void handleSelect(entry.id)}
              >
                <span className="model-switcher-option-text">
                  <span className="model-switcher-option-name">
                    {shortModelName(entry.id)}
                    {availability.badge && <span className="model-switcher-option-badge">{availability.badge}</span>}
                  </span>
                  <span className="model-switcher-option-endpoint">
                    {availability.reason ?? entry.endpoint}
                  </span>
                </span>
                {entry.id === selectedId && <CheckIcon />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
