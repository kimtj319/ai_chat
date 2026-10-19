import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { showToast } from "./Toast";
import { useDismiss } from "../hooks/useDismiss";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useModels } from "../hooks/useModels";
import { usePopoverFocus } from "../hooks/usePopoverFocus";
import { resolveSelectedModelId, shortModelName } from "../state/modelCatalog";
import {
  capabilityOf,
  kindMismatchReason,
  kindOf,
  listableModels,
  modelAvailability,
} from "../state/modelCapability";
import { useStore, useActiveConversation } from "../state/StoreContext";
import { ChevronDownIcon } from "./icons";
import { inSheet } from "./popoverSheet";
import "./ModelSelector.css";

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/**
 * 사이드바 바닥의 좁은 자리에 쓰는 이름 — 괄호 꼬리("(abliterated)")를 뗀다. 꼬리까지
 * 붙은 이름은 목록의 각 줄에, 원래 id 는 말풍선에 남는다.
 */
function triggerModelName(id: string): string {
  return shortModelName(id).replace(/\s*\([^)]*\)$/, "");
}

interface ModelSelectorProps {
  /**
   * 단추 모양. 비우면 사이드바 바닥의 글자 단추이고, 인사말 아래 칩(.empty-model-chip)·
   * 대화 머리 칩(.chat-header-model)은 제 클래스를 넘긴다 — 모양만 다르고 고르는 일은
   * 이 한 곳이 맡는다. 예전에는 칩이 사이드바 바닥의 선택기를 대신 열어, 어디를
   * 누르든 왼쪽 아래에서 목록이 떴다.
   */
  triggerClassName?: string;
  /** 단추 안에 보일 글(모델 이름을 받는다). 비우면 이름만. */
  renderLabel?: (name: string) => ReactNode;
  /** 목록이 열리는 쪽. 사이드바 바닥은 위, 칩은 아래. */
  placement?: "above" | "below";
}

/** The composer's reasoning popover, mirrored here: a text trigger that opens
 * a small listbox of every model in the catalog. The model is a per-
 * conversation field on the backend — selecting one PATCHes the open
 * conversation, or (when none is open) sets the default for the next one
 * created. */
export function ModelSelector({ triggerClassName, renderLabel, placement = "above" }: ModelSelectorProps = {}) {
  const { catalog, current, loading, error } = useModels();
  const { updateModel, ui, setLastModel } = useStore();
  const { activeConversation } = useActiveConversation();
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // 열면 포커스가 목록으로 들어가고 Esc 는 단추로 돌려준다(다른 팝오버와 같은 약속). 바깥 누르기는 useDismiss.
  // 칩은 폰에서 다른 머리 메뉴처럼 바텀시트로 연다(popoverSheet). 사이드바 바닥의 선택기는
  // 이미 서랍 안이라 제자리에서 연다.
  const narrow = useMediaQuery("(max-width: 640px)");
  const sheet = narrow && Boolean(triggerClassName);
  // 아래로 여는 칩의 목록은 body 에 띄워 단추 바로 아래에 고정한다. 인사말 아래 칩은
  // 스크롤되는 대화 목록(overflow: auto) 안에 있어서, 제자리에 두면 목록의 아래 가장자리에서
  // 잘려 입력창 뒤로 숨었다(첫 줄만 보였다).
  const floating = placement === "below" && !sheet;
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ position: "fixed", top: rect.bottom + 8, left: rect.left, bottom: "auto" });
    };
    place();
    // 단추가 움직이면(창 크기·스크롤) 목록이 떨어져 떠 있게 되므로 닫는다.
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, floating]);
  usePopoverFocus(open, popoverRef, triggerRef, () => setOpen(false));
  useDismiss(open, containerRef, () => setOpen(false), {
    // 시트는 body 로 포털되어 containerRef 밖에 있다. 스크림은 제 click 으로 닫는다.
    ignore: (target) => popoverRef.current?.contains(target) === true || target.closest?.(".popover-sheet-scrim") != null,
  });
  // 첫 항목이 아니라 지금 고른 모델에서 시작한다 — 화살표 한 번이 옆 모델이다.
  useEffect(() => {
    if (!open) return;
    popoverRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  if (loading || error || catalog.length === 0) {
    const note = loading ? "모델 불러오는 중…" : "모델 정보 없음";
    return (
      <div className="model-switcher">
        <span className={`${triggerClassName ?? "model-switcher-trigger"} model-switcher-trigger-muted`}>{note}</span>
      </div>
    );
  }

  const selectedId = resolveSelectedModelId(catalog, current, activeConversation?.model ?? null, ui.lastModel);
  const selectedLabel = triggerModelName(selectedId);

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

  function handlePopoverKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // 생성 중단(Esc)도 window 에서 같은 키를 듣는다.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    const items = [...(popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
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

  // 폰의 칩은 바텀시트, 데스크톱의 칩은 body 에 띄운 목록, 사이드바 바닥은 제자리.
  function floatingOrSheet(popover: ReactNode): ReactNode {
    if (sheet) return inSheet(true, () => setOpen(false), popover);
    return floating ? createPortal(popover, document.body) : popover;
  }

  return (
    <div className="model-switcher" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ?? "model-switcher-trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerClassName ? `모델 ${selectedLabel} — 모델 바꾸기` : undefined}
        title={selectedId}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="model-switcher-trigger-label">{renderLabel ? renderLabel(selectedLabel) : selectedLabel}</span>
        <ChevronDownIcon aria-hidden="true" />
      </button>

      {open && floatingOrSheet(
        <div
          ref={popoverRef}
          className={`model-switcher-popover${placement === "below" ? " below" : ""}${sheet ? " sheet" : ""}${floating ? " floating" : ""}`}
          style={floating ? (anchor ?? { visibility: "hidden" }) : undefined}
          role="listbox"
          aria-label="모델 선택"
          tabIndex={-1}
          onKeyDown={handlePopoverKeyDown}
        >
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
                title={availability.reason ?? entry.id}
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
        </div>,
      )}
    </div>
  );
}
