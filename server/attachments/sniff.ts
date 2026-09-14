import { looksBinary } from "../tools/readTextFile.js";
import type { AttachmentErrorCode } from "../types.js";

/**
 * Decide what an uploaded file actually is, from its bytes only.
 *
 * The declared Content-Type is a hint and nothing more: browsers guess it from
 * the extension, and a renamed file would otherwise walk straight into the
 * model as an image part the server then rejects. Everything below reads magic
 * bytes.
 */

/**
 * Ceiling on what one image can cost the prompt. Measured 2026-09-11 against
 * the 27B endpoint: prompt cost is clamp(round(w*h/1000), 66, 16386) — 64x64 and
 * 256x256 both cost 66, and 4200x4200, 5000x5000 and 8000x6000 all cost ~16,386
 * because the server rescales for its own vision tower. So no single image can
 * exceed ~6.3% of the 262,144-token window, and an image whose dimensions we
 * cannot read is charged this ceiling rather than guessed at.
 */
export const IMAGE_TOKEN_CEILING = 16386;
/** Floor of the same measured formula (the server's minimum rescale). */
const IMAGE_TOKEN_FLOOR = 66;

/**
 * Refused above this many pixels. The cost formula saturates at ~16.4M pixels,
 * so anything past 40M buys no fidelity — it only makes the server rescale a
 * payload that had to be uploaded, stored and base64'd first.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Per-edge cap, published to the client as maxImageWidth/maxImageHeight so it
 * can pick a downscale edge before uploading. 8000 is where the measurements
 * stopped telling us anything new: 4200x4200, 5000x5000 and 8000x6000 all cost
 * the same ~16,386 tokens, so a longer edge is upload time and nothing else.
 */
export const MAX_IMAGE_EDGE = 8000;

/** The measured prompt cost of an image of this size. */
export function imagePromptTokens(width: number, height: number): number {
  return Math.min(IMAGE_TOKEN_CEILING, Math.max(IMAGE_TOKEN_FLOOR, Math.round((width * height) / 1000)));
}

/**
 * The refusal body for PDF and Office documents, verbatim. Dependency-free PDF
 * text extraction was measured and is not viable: a generated control PDF gave
 * 4,960 characters and two real Korean PDFs gave 0 — the text is in embedded
 * CID fonts with no ToUnicode mapping we can honour without a parser. Telling
 * the user to screenshot the pages they care about is the path that actually
 * works, because the model reads images.
 */
export const UNSUPPORTED_DOCUMENT_MESSAGE =
  "PDF·오피스 문서는 아직 지원하지 않습니다. 필요한 페이지를 화면 캡처해서 이미지로 올려 주시면 모델이 그대로 읽을 수 있습니다. (텍스트로 저장한 .txt·.md·.csv 파일도 됩니다.)";

export type SniffResult =
  | {
      ok: true;
      kind: "image";
      mime: string;
      width?: number;
      height?: number;
      estimatedTokens: number;
    }
  | { ok: true; kind: "text"; mime: string; text: string }
  | { ok: false; status: number; code: AttachmentErrorCode; message: string };

interface Dimensions {
  width: number;
  height: number;
}

const starts = (buf: Buffer, bytes: number[], offset = 0): boolean =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (buf: Buffer, start: number, end: number): string =>
  buf.length >= end ? buf.toString("latin1", start, end) : "";

/** PNG: the IHDR chunk is fixed at offset 8 and carries the size as two BE uint32s. */
function pngSize(buf: Buffer): Dimensions | null {
  if (buf.length < 24 || ascii(buf, 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: walk the segment chain to the first SOF. There is no fixed offset — an
 * Exif/ICC segment of any size sits in front of it (the measured fixture from
 * sips carries one), so the length field of each segment is what moves us on.
 */
function jpegSize(buf: Buffer): Dimensions | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++; // fill byte or padding: resync on the next marker
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Standalone markers (no length field).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan — past this point it is entropy-coded data, not segments.
    if (marker === 0xda) return null;
    const length = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** GIF: logical screen descriptor, two LE uint16s right after the 6-byte header. */
function gifSize(buf: Buffer): Dimensions | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/**
 * WebP: three container flavours, each storing the size differently.
 * VP8 (lossy) hides it behind the 3-byte sync code, VP8L (lossless) packs
 * w-1/h-1 into 28 bits, VP8X (extended) stores a 24-bit canvas size.
 */
function webpSize(buf: Buffer): Dimensions | null {
  if (buf.length < 30) return null;
  const fourcc = ascii(buf, 12, 16);
  if (fourcc === "VP8 ") {
    if (!starts(buf, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X") {
    const width = buf[24]! | (buf[25]! << 8) | (buf[26]! << 16);
    const height = buf[27]! | (buf[28]! << 8) | (buf[29]! << 16);
    return { width: width + 1, height: height + 1 };
  }
  return null;
}

const IMAGE_FORMATS: Array<{ mime: string; matches: (buf: Buffer) => boolean; size: (buf: Buffer) => Dimensions | null }> = [
  { mime: "image/png", matches: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), size: pngSize },
  { mime: "image/jpeg", matches: (b) => starts(b, [0xff, 0xd8, 0xff]), size: jpegSize },
  { mime: "image/gif", matches: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a", size: gifSize },
  { mime: "image/webp", matches: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP", size: webpSize },
];

/**
 * Image containers the servers reject, refused here instead of at generation
 * time. Measured 2026-09-11: a HEIC data: URL comes back
 * 400 "Invalid image format" and an SVG the same way — and by then the upload,
 * the storage and the user's turn have all been spent.
 */
function refusedImageMime(buf: Buffer): string | null {
  // HEIC/HEIF: "ftyp" at offset 4 with a heic/heix/hevc/mif1 brand.
  if (ascii(buf, 4, 8) === "ftyp") {
    const brand = ascii(buf, 8, 12);
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand)) return `HEIC/HEIF/AVIF (${brand})`;
  }
  if (starts(buf, [0x42, 0x4d])) return "BMP";
  if (ascii(buf, 0, 4) === "II\x2a\x00" || ascii(buf, 0, 4) === "MM\x00\x2a") return "TIFF";
  // SVG decodes as valid UTF-8, so it has to be caught before the text path.
  const head = buf.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "SVG";
  return null;
}

/**
 * Classify an upload. `declaredMime` is accepted only as a tiebreaker for the
 * stored text mime; it never decides the kind.
 */
export function sniffAttachment(buf: Buffer, limits: { maxImageBytes: number; maxTextBytes: number }): SniffResult {
  if (buf.length === 0) {
    return { ok: false, status: 400, code: "unsupported_type", message: "빈 파일은 올릴 수 없습니다." };
  }

  // Documents first: a PDF is valid-looking binary and a .docx is a ZIP, and
  // both deserve the specific answer rather than "unsupported type".
  if (ascii(buf, 0, 5) === "%PDF-" || starts(buf, [0x50, 0x4b, 0x03, 0x04])) {
    return { ok: false, status: 415, code: "unsupported_document", message: UNSUPPORTED_DOCUMENT_MESSAGE };
  }

  for (const format of IMAGE_FORMATS) {
    if (!format.matches(buf)) continue;
    if (buf.length > limits.maxImageBytes) {
      return {
        ok: false,
        status: 413,
        code: "too_large",
        message: `이미지가 너무 큽니다. ${formatMb(buf.length)}MB (최대 ${formatMb(limits.maxImageBytes)}MB)`,
      };
    }
    const size = format.size(buf);
    if (size && (size.width <= 0 || size.height <= 0)) {
      return { ok: false, status: 400, code: "unsupported_type", message: "이미지 크기를 읽을 수 없습니다." };
    }
    if (size && (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE)) {
      return {
        ok: false,
        status: 413,
        code: "too_large",
        message: `이미지 한 변이 너무 깁니다. ${size.width}x${size.height} (최대 ${MAX_IMAGE_EDGE}px). 줄여서 올려 주세요.`,
      };
    }
    if (size && size.width * size.height > MAX_IMAGE_PIXELS) {
      return {
        ok: false,
        status: 413,
        code: "too_large",
        message: `이미지 해상도가 너무 큽니다. ${size.width}x${size.height} (최대 ${MAX_IMAGE_PIXELS.toLocaleString("en-US")}픽셀)`,
      };
    }
    return {
      ok: true,
      kind: "image",
      mime: format.mime,
      ...(size ? { width: size.width, height: size.height } : {}),
      // An unreadable header is accepted but charged the ceiling: the budget
      // must never under-count an image it cannot measure.
      estimatedTokens: size ? imagePromptTokens(size.width, size.height) : IMAGE_TOKEN_CEILING,
    };
  }

  const refused = refusedImageMime(buf);
  if (refused) {
    return {
      ok: false,
      status: 415,
      code: "unsupported_type",
      message: `${refused} 이미지는 지원하지 않습니다. PNG·JPEG·GIF·WebP 로 변환해서 올려 주세요.`,
    };
  }

  if (buf.length > limits.maxTextBytes) {
    return {
      ok: false,
      status: 413,
      code: "too_large",
      message: `텍스트 파일이 너무 큽니다. ${formatMb(buf.length)}MB (최대 ${formatMb(limits.maxTextBytes)}MB)`,
    };
  }
  // The binary heuristic is read_text_file's own (tools/readTextFile.ts), so a
  // file this route accepts is exactly a file that tool would have read.
  if (looksBinary(buf)) {
    return {
      ok: false,
      status: 400,
      code: "undecodable_text",
      message: "이미지도 UTF-8 텍스트도 아닌 파일입니다. PNG·JPEG·GIF·WebP 이미지나 UTF-8 텍스트 파일만 올릴 수 있습니다.",
    };
  }
  let text: string;
  try {
    // fatal:true is the point — a CP949/EUC-KR .txt has to be refused with an
    // explanation, not silently mangled into U+FFFD inside the prompt.
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "undecodable_text",
      message: "UTF-8 로 읽을 수 없는 파일입니다. UTF-8 로 저장한 뒤 다시 올려 주세요. (CP949/EUC-KR 인코딩은 지원하지 않습니다)",
    };
  }
  return {
    ok: true,
    kind: "text",
    mime: "text/plain; charset=utf-8",
    // A BOM is a zero-width space in the middle of the prompt otherwise, and
    // Korean Windows editors write one by default.
    text: text.startsWith("﻿") ? text.slice(1) : text,
  };
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
