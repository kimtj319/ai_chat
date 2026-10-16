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
 * The thumb is transparent by default and fades in while the area scrolls
 * (`fade` below), so the gutter's width never changes and nothing reflows when
 * it appears: only a colour does. It fades out a beat after the last scroll
 * event rather than blinking off mid-drag.
 *
 * ONE DOCUMENT LISTENER, NOT ONE PER AREA. `scroll` does not bubble, but it
 * does capture, so a single capturing listener sees every area scroll: the
 * transcript, the sidebar, and the thinking and tool panels nested inside a
 * message, which nothing had ever wired up. It also cannot fall into the trap
 * the per-area version did — that one took a ref and read `ref.current` once,
 * but ChatView returns early until a conversation has loaded, so the transcript
 * did not exist yet when the hook ran and its bar never appeared at all.
 */
/**
 * 0.7s after the last scroll event, then a 0.3s fade: gone ~1s after the area
 * stops moving. A trackpad keeps firing scroll events through its momentum, so
 * a full second of delay on top of that read as ~3s from the finger lifting.
 */
const HIDE_AFTER_MS = 700;
const FADE_IN_MS = 200;
const FADE_OUT_MS = 300;

/**
 * Animates --sb-alpha (global.css), which the thumb's colour is mixed from.
 * Chrome neither transitions ::-webkit-scrollbar-thumb nor repaints it when
 * only an attribute selector stops matching (measured: the attribute cleared
 * at 1.0s and the thumb snapped off, no fade), but it does repaint every frame
 * of an animated registered property. The Web Animations API rather than a CSS
 * transition, so it can never replace a scroll area's own `transition` list.
 */
function fade(node: HTMLElement, to: number, duration: number): void {
  node.animate([{ "--sb-alpha": String(to) } as Keyframe], { duration, fill: "forwards", easing: "ease" });
}

export function useScrollbarFade(): void {
  useEffect(() => {
    // Per element, because two areas can be scrolling at once — a nested tool
    // panel and the transcript carrying it — and a single timer would let
    // whichever stopped first blank the other's bar mid-scroll.
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

    const onScroll = (event: Event) => {
      const node = event.target;
      if (!(node instanceof HTMLElement)) return;
      if (node.dataset.scrolling !== "true") {
        node.dataset.scrolling = "true";
        fade(node, 1, FADE_IN_MS);
      }
      clearTimeout(timers.get(node));
      timers.set(
        node,
        setTimeout(() => {
          delete node.dataset.scrolling;
          timers.delete(node);
          fade(node, 0, FADE_OUT_MS);
        }, HIDE_AFTER_MS),
      );
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const [node, timer] of timers) {
        clearTimeout(timer);
        delete node.dataset.scrolling;
        fade(node, 0, 0);
      }
    };
  }, []);
}
