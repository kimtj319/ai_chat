import { useEffect, useRef, type RefObject } from "react";
import { pushOverlay } from "../ui/overlayStack";

interface DismissOptions {
  /** Close on Escape too. Popovers that run usePopoverFocus leave Escape to it. */
  escape?: boolean;
  /** A mousedown on this target is not a click away (a portalled sheet, its scrim, a dialog opened from the menu). */
  ignore?: (target: Element) => boolean;
}

/**
 * The open/closed bookkeeping every popover shares: while `open`, Escape is its
 * own (the global Escape that stops a generation must not fire with it), and a
 * mousedown outside `containerRef` closes it.
 */
export function useDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  close: () => void,
  { escape = false, ignore }: DismissOptions = {},
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const ignoreRef = useRef(ignore);
  ignoreRef.current = ignore;

  // 열려 있는 동안은 Esc 가 이쪽 몫이다 — 전역 Esc(생성 중단)와 겹치지 않게.
  useEffect(() => (open ? pushOverlay() : undefined), [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Element;
      if (ignoreRef.current?.(target)) return;
      if (containerRef.current && !containerRef.current.contains(target)) closeRef.current();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
    }
    document.addEventListener("mousedown", handlePointerDown);
    if (escape) document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      if (escape) document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, escape, containerRef]);
}
