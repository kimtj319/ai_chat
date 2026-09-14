import { useEffect, useRef } from "react";
import "./AppBackdrop.css";

/**
 * The app's background: three soft colour fields that drift on their own and
 * lean towards the pointer.
 *
 * ONE backdrop for the whole window, behind both the sidebar and the
 * transcript, rather than a patch behind each. That is what makes the glass
 * sidebar read as glass — it blurs this, and what it blurs has to continue
 * past its edges, or the panel looks like a sticker over a coloured rectangle.
 *
 * The drift is a CSS animation on the `translate` property and the pointer
 * lean is a `transform` on the same element: two independent properties, so
 * neither has to know about the other and JavaScript never touches a frame of
 * the animation. All this effect does per pointer move is write two numbers,
 * coalesced to one write per frame.
 */
export function AppBackdrop() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Someone who has asked for less motion gets the colour and none of the
    // movement; the CSS turns the drift off for the same query.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let x = 0;
    let y = 0;

    const write = () => {
      frame = 0;
      node.style.setProperty("--pointer-x", x.toFixed(3));
      node.style.setProperty("--pointer-y", y.toFixed(3));
    };

    const onMove = (event: PointerEvent) => {
      // -1 to 1 across the window, so each field can scale it by its own depth.
      x = (event.clientX / window.innerWidth) * 2 - 1;
      y = (event.clientY / window.innerHeight) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(write);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="app-backdrop" ref={ref} aria-hidden="true">
      {/* The fields live one level in so a single mask can hold them off the
          middle of the window, where the transcript is read. Masking each
          field instead would resolve the mask's percentages against that
          field's own box, which is far larger than the window and offset off
          its edges — the mask has to be measured against the window. */}
      <div className="app-backdrop-fields">
        <span className="app-backdrop-field field-1" />
        <span className="app-backdrop-field field-2" />
        <span className="app-backdrop-field field-3" />
      </div>
    </div>
  );
}
