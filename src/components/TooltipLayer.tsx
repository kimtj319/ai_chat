import { useEffect, useState } from "react";
import "./TooltipLayer.css";

/**
 * Tooltips for icon-only controls, shown only after the pointer has rested on
 * one for a while.
 *
 * One listener on the document rather than a wrapper around each button: there
 * are two dozen of these, they sit inside flex rows whose spacing a wrapper
 * element would disturb, and a bubble positioned from the trigger's own
 * rectangle needs no layout box of its own. A control opts in by carrying
 * `data-tooltip`; the text is read from that attribute.
 *
 * The native `title` attribute cannot do this job: the browser decides when it
 * appears (around a second) and that is not configurable, so controls that want
 * this tooltip carry `data-tooltip` INSTEAD of `title`, never both — two
 * tooltips for one button, on two different clocks, is worse than none. The
 * accessible name comes from `aria-label`, which every one of them already has,
 * so nothing is lost by dropping `title`.
 */
const DELAY_MS = 3000;

interface Bubble {
  text: string;
  left: number;
  top: number;
}

export function TooltipLayer() {
  const [bubble, setBubble] = useState<Bubble | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armed: HTMLElement | null = null;

    const cancel = () => {
      clearTimeout(timer);
      armed = null;
      setBubble(null);
    };

    const onOver = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (!target) {
        if (armed) cancel();
        return;
      }
      // Moving within the same control (over its icon, say) must not restart
      // the wait, or a tooltip on a small button would never arrive.
      if (target === armed) return;
      clearTimeout(timer);
      armed = target;
      setBubble(null);
      timer = setTimeout(() => {
        const text = target.dataset.tooltip;
        if (!text || !target.isConnected) return;
        const rect = target.getBoundingClientRect();
        setBubble({ text, left: rect.left + rect.width / 2, top: rect.bottom + 8 });
      }, DELAY_MS);
    };

    // Anything that means the pointer has moved on, or that the user has acted:
    // a tooltip outliving its trigger is a stuck label on the page.
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousedown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mousedown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  if (!bubble) return null;

  return (
    <span className="icon-tooltip" role="tooltip" style={{ left: bubble.left, top: bubble.top }}>
      {bubble.text}
    </span>
  );
}
