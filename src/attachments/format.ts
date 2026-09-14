// Pure helpers shared by the composer strip, the chips and the transcript.
// Deliberately free of DOM/React so they can be exercised directly.

/** Longest edge the client downscales an image to before uploading. */
export const MAX_IMAGE_EDGE = 2048;

/** How many attachments one message may carry. */
export const MAX_ATTACHMENTS = 10;

/**
 * Ceiling on the *source* image, checked before we even try to decode it. The
 * server's own byte cap applies to what we upload, which is the downscaled
 * copy; this one only says how large a file we are willing to open at all.
 */
export const MAX_SOURCE_IMAGE_BYTES = 40 * 1024 * 1024;

/**
 * The model's measured image cost: clamp(round(w*h/1000), 66, 16386) tokens.
 * Because the client downscales before upload, the width/height fed in here
 * are the ones the model actually sees — so the number on a chip is the
 * number the request actually pays.
 */
export function estimateImageTokens(width: number, height: number): number {
  const raw = Math.round((width * height) / 1000);
  if (raw < 66) return 66;
  if (raw > 16386) return 16386;
  return raw;
}

// Hangul/CJK and full-width punctuation. These cost far more tokens per
// character than Latin text, so a single chars/4 rule would understate a
// Korean CSV by roughly 3x.
const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\u303f\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/**
 * Rough token count for a text attachment, used only until the server's own
 * `estimatedTokens` comes back on the 201. Hangul/CJK ~1.2 chars per token,
 * everything else ~4.
 */
export function estimateTextTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (WIDE_CHAR.test(ch)) wide += 1;
    else narrow += 1;
  }
  if (wide === 0 && narrow === 0) return 0;
  return Math.max(1, Math.round(wide / 1.2 + narrow / 4));
}

/**
 * Shorten a filename from the middle so the extension stays visible — the
 * extension is what tells the user which of three near-identical exports
 * they just attached, so trailing ellipsis (which eats it) is wrong here.
 */
export function middleEllipsis(name: string, max: number): string {
  if (name.length <= max) return name;

  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && name.length - dot <= 8;
  const ext = hasExt ? name.slice(dot) : "";
  const stem = hasExt ? name.slice(0, dot) : name;

  // One character for the ellipsis itself.
  const keep = max - ext.length - 1;
  // Too little room to show both ends: fall back to a plain head + ellipsis.
  if (keep < 4) return `${name.slice(0, Math.max(1, max - 1))}…`;

  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
}

/** Box the given size into `edge` on its longest side, never upscaling. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge || longest === 0) return { width, height };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("ko-KR");
}

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/heic": ".heic",
};

export function imageExtension(mime: string): string {
  return IMAGE_EXTENSION_BY_MIME[mime.toLowerCase()] ?? ".png";
}

function two(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Every clipboard image arrives as "image.png", so a pasted screenshot has to
 * be named here or a strip of three of them is unreadable. Collisions inside
 * one draft get -2, -3, ... (two screenshots in the same second are common).
 */
export function pastedImageName(taken: Iterable<string>, mime: string, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const base = `화면캡처-${stamp}`;
  const ext = imageExtension(mime);

  const used = new Set(taken);
  let candidate = `${base}${ext}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }
  return candidate;
}

/** True for the clipboard's own placeholder names, which carry no meaning. */
export function isGenericPastedName(name: string): boolean {
  return name.trim().length === 0 || /^image\.[a-z0-9]+$/i.test(name);
}
