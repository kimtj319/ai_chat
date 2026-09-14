import { useEffect } from "react";

/**
 * Shows a scroll area's scrollbar only while it is being scrolled — every
 * scroll area in the app, from one listener.
 *
 * global.css styles `::-webkit-scrollbar`, and styling it at all is what turns
 * Chrome's overlay scrollbar — which fades itself out — into a classic one that
 * sits there permanently. That was fine when a list was short and became a
 * standing grey bar down the sidebar once the conversation list grew.
 *
 * The thumb is transparent by default and painted while `data-scrolling` is
 * set, so the gutter's width never changes and nothing reflows when it appears:
 * only a colour does. The attribute is cleared a beat after the last scroll
 * event, which is what makes it read as fading out rather than blinking off
 * mid-drag.
 *
 * ONE DOCUMENT LISTENER, NOT ONE PER AREA. `scroll` does not bubble, but it
 * does capture, so a single capturing listener sees every area scroll: the
 * transcript, the sidebar, and the thinking and tool panels nested inside a
 * message, which nothing had ever wired up. It also cannot fall into the trap
 * the per-area version did — that one took a ref and read `ref.current` once,
 * but ChatView returns early until a conversation has loaded, so the transcript
 * did not exist yet when the hook ran and its bar never appeared at all.
 */
const HIDE_AFTER_MS = 1000;

export function useScrollbarFade(): void {
  useEffect(() => {
    // Per element, because two areas can be scrolling at once — a nested tool
    // panel and the transcript carrying it — and a single timer would let
    // whichever stopped first blank the other's bar mid-scroll.
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

    const onScroll = (event: Event) => {
      const node = event.target;
      if (!(node instanceof HTMLElement)) return;
      node.dataset.scrolling = "true";
      clearTimeout(timers.get(node));
      timers.set(
        node,
        setTimeout(() => {
          delete node.dataset.scrolling;
          timers.delete(node);
        }, HIDE_AFTER_MS),
      );
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const [node, timer] of timers) {
        clearTimeout(timer);
        delete node.dataset.scrolling;
      }
    };
  }, []);
}
