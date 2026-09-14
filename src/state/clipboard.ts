/**
 * Put text on the clipboard, and say whether it actually worked.
 *
 * `navigator.clipboard` exists only in a secure context. This app is served
 * over plain HTTP on the deployment it was built for, where the whole object is
 * `undefined` — reading `.writeText` off it throws, and the copy buttons did
 * nothing at all while reporting nothing at all. So the modern call is tried
 * first and a textarea plus `execCommand("copy")` is what actually runs there.
 *
 * Returns false rather than throwing: the caller has to be able to tell the
 * difference between a copy and a failed copy, which is the whole point.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permissions, focus) — the fallback below may still work.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off-screen rather than display:none — execCommand ignores an element that
  // is not rendered, and anything on-screen would make the page jump.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);

  // Copying steals the selection, so whatever the reader had highlighted is put
  // back afterwards.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (selection && previous) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}
