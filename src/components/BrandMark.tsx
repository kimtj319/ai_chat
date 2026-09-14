import { useId } from "react";

interface BrandMarkProps {
  /** Rendered size in px. The glyph is drawn to read at the sidebar's 24. */
  size?: number;
  className?: string;
}

/**
 * The app's mark: a console prompt — a chevron and its cursor rule — set in a
 * gradient tile.
 *
 * A filled tile rather than a line drawing, because the same shape has to work
 * as the browser tab's icon at 16px, where 1.9px strokes on a transparent
 * ground turn to mush and a solid silhouette still reads. The glyph is the
 * prompt every console shows, which is what this app is: somewhere you address
 * a model directly.
 *
 * Deliberately says nothing about any one vendor — several vendors' models are
 * served through this app — so it shows what the app *is* rather than whose
 * model is behind it.
 *
 * Colours come from the gradient tokens in variables.css, which are
 * theme-invariant by design, so the same mark carries both themes; the stops
 * are read through `var()` rather than hard-coded, so retheming the tokens
 * retints the mark. public/favicon.svg is this same drawing with the stops
 * written out, because a favicon is fetched outside the document and cannot
 * see these variables — change one and change the other.
 */
export function BrandMark({ size = 24, className }: BrandMarkProps) {
  // Two marks can be on screen at once (the auth screen re-renders on a mode
  // switch), and a duplicated gradient id would make one of them reference the
  // other's def.
  const gradientId = useId();

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      // Inline, not the width/height attributes: global.css sets
      // `svg { width: 1em }`, and a CSS rule outranks a presentation attribute.
      style={{ width: size, height: size, flexShrink: 0 }}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--gradient-start)" />
          <stop offset="50%" stopColor="var(--gradient-mid)" />
          <stop offset="100%" stopColor="var(--gradient-end)" />
        </linearGradient>
      </defs>
      {/* A squircle, not a rounded rect: rx is roughly a third of the side,
          the proportion a platform app icon uses. */}
      <rect x="2" y="2" width="20" height="20" rx="6.4" fill={`url(#${gradientId})`} />
      {/* White in both themes — it sits on the gradient, never on the page. */}
      <path d="M8.6 9.1 11.6 12 8.6 14.9" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 15.1h3" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** The wordmark beside the mark. Kept here so both live in one place. */
export const BRAND_WORDMARK = "AI Console";
