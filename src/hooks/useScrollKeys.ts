import { useEffect } from "react";
import { pageDistance, scrollKeyAction, scrollTarget, type FocusKind } from "../state/scrollKeys";

/** 이 키들이 제 뜻을 갖는 곳. 메뉴의 Home/End, 모달 안의 스크롤은 그쪽에 맡긴다. */
const WIDGET = '[role="menu"], [role="listbox"], [role="tablist"], [role="slider"], [role="grid"], [aria-modal="true"]';
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function focusKind(active: Element | null): FocusKind {
  if (!active || active === document.body) return "other";
  if (active.closest(WIDGET)) return "widget";
  if (active.matches(".composer-textarea")) return "composer";
  if (active.matches(EDITABLE)) return "editable";
  return "other";
}

/** 출처 창에서 지금 넘길 칸 — PDF 쪽 칸이나 글 칸. 창이 닫혀 있으면 null. */
function panelScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".source-panel.open :is(.source-pdf-slot:not(.empty) .source-pdf, .source-text)");
}

/**
 * 칸 안에서 실제로 보이는 높이. 대화 본문은 머리(폰)와 입력창 묶음 밑으로까지 흐르므로
 * clientHeight 를 그대로 쓰면 가려진 줄을 건너뛴다 — 그 둘에 가리지 않은 부분만 센다.
 */
function visibleHeight(el: HTMLElement): number {
  const box = el.getBoundingClientRect();
  let top = box.top;
  let bottom = box.bottom;
  if (el.matches(".chat-message-list")) {
    const header = document.querySelector(".chat-header")?.getBoundingClientRect();
    const dock = document.querySelector(".composer-dock")?.getBoundingClientRect();
    if (header && header.bottom > top && header.bottom < bottom) top = header.bottom;
    if (dock && dock.top > top && dock.top < bottom) bottom = dock.top;
  }
  return bottom - top;
}

/** 부드럽게 넘기는 중에 또 누르면 아직 가는 중인 자리에서 이어 센다 — 지금 자리에서 세면 연달아 눌러도 덜 간다. */
const pending = new WeakMap<Element, { top: number; at: number }>();
const SMOOTH_MS = 450;

/**
 * PageUp·PageDown·Home·End 로 대화 본문과 출처 창(PDF 포함)을 넘긴다.
 *
 * 브라우저에 맡기면 아무 데도 닿지 않는다: 스크롤은 문서가 아니라 안쪽 칸에 있고,
 * 포커스는 대개 입력창이나 body 에 있다. 그래서 window 에서 받아 넘길 칸을 골라 준다.
 * 규칙(어느 키를 받고 어느 칸으로 보낼지)은 state/scrollKeys.ts 에 있다.
 *
 * 출처 창이 열려 있으면 마지막으로 손댄 쪽 — 포인터를 올렸거나 포커스가 들어간 쪽 —
 * 을 넘긴다. 입력창에 커서를 둔 채 PDF 위에 포인터를 올리고 PageDown 을 누르면 PDF 다.
 */
export function useScrollKeys(): void {
  useEffect(() => {
    let lastZone: "panel" | "chat" | null = null;
    function note(event: Event) {
      const target = event.target as Element | null;
      if (!target?.closest) return;
      lastZone = target.closest(".source-panel") ? "panel" : "chat";
    }

    function onKeyDown(event: KeyboardEvent) {
      const active = document.activeElement;
      const focus = focusKind(active);
      const action = scrollKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        focus,
        composerScrollable: focus === "composer" && active!.scrollHeight > active!.clientHeight + 1,
      });
      if (!action) return;

      const panel = panelScroller();
      const covers = panel !== null && getComputedStyle(panel.closest(".source-panel")!).position === "fixed";
      const which = scrollTarget({ open: panel !== null, covers }, lastZone);
      const el = which === "panel" ? panel : document.querySelector<HTMLElement>(".chat-message-list");
      if (!el) return;
      event.preventDefault();

      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const max = el.scrollHeight - el.clientHeight;
      const going = pending.get(el);
      const from = smooth && going && performance.now() - going.at < SMOOTH_MS ? going.top : el.scrollTop;
      const top =
        action.kind === "edge"
          ? action.edge === "start"
            ? 0
            : max
          : Math.min(max, Math.max(0, from + action.direction * pageDistance(visibleHeight(el))));
      pending.set(el, { top, at: performance.now() });
      el.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    }

    window.addEventListener("pointermove", note, { passive: true });
    window.addEventListener("pointerdown", note, { passive: true });
    window.addEventListener("focusin", note);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", note);
      window.removeEventListener("pointerdown", note);
      window.removeEventListener("focusin", note);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
