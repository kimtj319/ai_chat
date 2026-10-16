import { useEffect, useState } from "react";
import "./TooltipLayer.css";

/**
 * Tooltips for icon-only controls, shown as soon as the pointer reaches one.
 * (It waited three seconds until 2026-10-16; by then most people had clicked
 * or moved on, so the label never did its job.)
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
interface Bubble {
  text: string;
  left: number;
  top: number;
  /** Above the trigger when there is no room below (the composer's buttons). */
  above: boolean;
}

/** Room a one-line bubble needs below its trigger, gap included. */
const BELOW_ROOM = 40;
/** Keeps a bubble near the window's edge from being cut off. */
const EDGE = 8;
const MAX_WIDTH = 260;

function place(target: HTMLElement, text: string): Bubble {
  const rect = target.getBoundingClientRect();
  const above = rect.bottom + BELOW_ROOM > window.innerHeight;
  const half = Math.min(MAX_WIDTH, text.length * 8 + 24) / 2;
  const centre = rect.left + rect.width / 2;
  const left = Math.min(Math.max(centre, EDGE + half), window.innerWidth - EDGE - half);
  return { text, left, top: above ? rect.top - 8 : rect.bottom + 8, above };
}

export function TooltipLayer() {
  const [bubble, setBubble] = useState<Bubble | null>(null);

  useEffect(() => {
    let armed: HTMLElement | null = null;

    const cancel = () => {
      armed = null;
      setBubble(null);
    };

    const onOver = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (!target) {
        if (armed) cancel();
        return;
      }
      // Moving within the same control (over its icon, say) keeps the bubble.
      if (target === armed) return;
      armed = target;
      const text = target.dataset.tooltip;
      setBubble(text ? place(target, text) : null);
    };

    // Anything that means the pointer has moved on, or that the user has acted:
    // a tooltip outliving its trigger is a stuck label on the page.
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousedown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);

    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mousedown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  if (!bubble) return null;

  return (
    <span
      key={`${bubble.text}@${bubble.left},${bubble.top}`}
      className="icon-tooltip"
      data-above={bubble.above || undefined}
      role="tooltip"
      style={{ left: bubble.left, top: bubble.top }}
    >
      {bubble.text}
    </span>
  );
}
