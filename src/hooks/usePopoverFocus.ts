import { useEffect, useRef, type RefObject } from "react";

/** Tab 이 닿을 수 있는 것들(Modal 과 같은 목록). App 의 서랍도 이것으로 첫 칸을 찾는다. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 글을 쓰는 칸. 여는 순간 여기로 들어가면 폰에서 자판이 튀어 올라온다. */
const TEXT_ENTRY =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]), textarea, select';

/**
 * 입력창·머리의 작은 팝오버(+ 메뉴, 추론, 공지)가 키보드에서 지키는 약속.
 *
 * - 열리면 포커스가 안의 첫 항목으로 들어간다(글 칸은 건너뛴다). 항목이 없으면
 *   팝오버 자체로 — 그래서 팝오버에는 tabIndex={-1} 이 있어야 한다.
 * - Esc 는 닫고 포커스를 트리거로 돌려준다.
 * - 포커스가 팝오버 밖으로 나가면(Tab 으로 지나가면) 닫는다. 단, 트리거로 돌아간
 *   것(Shift+Tab)과 팝오버에서 연 대화상자로 옮겨 간 것은 나간 것이 아니다.
 *   relatedTarget 이 없는 경우(마우스로 바깥을 눌렀을 때, 창이 포커스를 잃었을 때)는
 *   여기서 판단하지 않는다 — 바깥 누르기는 각 컴포넌트의 mousedown 처리가 맡는다.
 *   여기서 닫으면 트리거를 누른 순간 닫혔다가 click 으로 다시 열린다.
 * - 안의 항목을 눌러 닫히면(그 항목이 사라지며 포커스가 body 로 떨어지면) 트리거로
 *   돌려준다.
 *
 * containerRef 는 트리거를 뺀 팝오버 자체다 — 폰에서는 body 로 포털되므로 트리거와
 * 같은 상자 안에 있지 않다.
 */
export function usePopoverFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const popover = containerRef.current;
    if (!popover) return;
    const trigger = triggerRef.current;

    const first = [...popover.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !el.matches(TEXT_ENTRY));
    (first ?? popover).focus({ preventScroll: true });
    let inside = popover.contains(document.activeElement);

    function onFocusIn() {
      inside = true;
    }
    function onFocusOut(event: FocusEvent) {
      const next = event.relatedTarget as Element | null;
      if (!next || popover!.contains(next)) return;
      inside = false;
      if (trigger?.contains(next)) return;
      if (next.closest?.('[role="dialog"]')) return;
      onCloseRef.current();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // 팝오버에서 연 대화상자(크롬 연결 안내 등)의 Esc 는 그 대화상자의 몫이다.
      const target = event.target as Element | null;
      if (target && !popover!.contains(target) && target.closest?.('[aria-modal="true"]')) return;
      onCloseRef.current();
      trigger?.focus({ preventScroll: true });
    }

    popover.addEventListener("focusin", onFocusIn);
    popover.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      popover.removeEventListener("focusin", onFocusIn);
      popover.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      const active = document.activeElement;
      if (inside && (active === null || active === document.body)) trigger?.focus({ preventScroll: true });
    };
  }, [open, containerRef, triggerRef]);
}
