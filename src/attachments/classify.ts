// One validator for all three attach paths (picker, drop, paste). Runs on the
// filename plus the first 8 KB of the file, *before* any upload starts —
// nobody should watch a progress bar for a file that will be refused.

export type AttachmentKind = "image" | "text";

/** Document families the server refuses, each with its own workaround copy. */
export type DocumentFormat = "pdf" | "excel" | "word" | "hwp" | "powerpoint";

export type Classification =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; reason: "document"; format: DocumentFormat }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "undecodable" };

/** How many bytes of the head `classifyFile` wants. */
export const HEAD_BYTES = 8192;

function startsWith(head: Uint8Array, signature: number[], offset = 0): boolean {
  if (head.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (head[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(head: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < head.length; i += 1) {
    out += String.fromCharCode(head[i] as number);
  }
  return out;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

const DOCUMENT_BY_EXTENSION: Record<string, DocumentFormat> = {
  pdf: "pdf",
  xls: "excel",
  xlsx: "excel",
  xlsm: "excel",
  xlsb: "excel",
  doc: "word",
  docx: "word",
  docm: "word",
  rtf: "word",
  hwp: "hwp",
  hwpx: "hwp",
  hml: "hwp",
  ppt: "powerpoint",
  pptx: "powerpoint",
  pptm: "powerpoint",
  odt: "word",
  ods: "excel",
  odp: "powerpoint",
};

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "webp",
  "gif",
  "bmp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "ico",
]);

/** ISO-BMFF brands that are actually still images, not video. */
const IMAGE_FTYP_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

/**
 * A ZIP or a CFB/OLE2 file is only a container — the extension is what names
 * the application, and that is what the refusal copy has to say.
 */
function documentByMagic(head: Uint8Array, ext: string): DocumentFormat | null {
  // %PDF-
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  // HWP 3.x writes its name in plain ASCII at offset 0.
  if (ascii(head, 0, 17) === "HWP Document File") return "hwp";

  const isZip =
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(head, [0x50, 0x4b, 0x07, 0x08]);
  const isCfb = startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (isZip || isCfb) return DOCUMENT_BY_EXTENSION[ext] ?? null;

  return null;
}

function imageByMagic(head: Uint8Array): boolean {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true; // PNG
  if (startsWith(head, [0xff, 0xd8, 0xff])) return true; // JPEG
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return true;
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return true;
  if (startsWith(head, [0x42, 0x4d])) return true; // BMP
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return true; // TIFF
  if (ascii(head, 4, 4) === "ftyp" && IMAGE_FTYP_BRANDS.has(ascii(head, 8, 4).toLowerCase())) return true;
  return false;
}

/** Containers that are neither an image nor text and have no workaround. */
function binaryByMagic(head: Uint8Array): boolean {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return true; // zip (not an Office file)
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) return true; // CFB (not an Office/HWP file)
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21])) return true; // rar
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return true; // 7z
  if (startsWith(head, [0x1f, 0x8b])) return true; // gzip
  if (startsWith(head, [0x42, 0x5a, 0x68])) return true; // bzip2
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a])) return true; // xz
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  if (startsWith(head, [0x4d, 0x5a])) return true; // PE/DOS
  if (startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xce, 0xfa, 0xed, 0xfe])) return true; // Mach-O
  if (startsWith(head, [0xca, 0xfe, 0xba, 0xbe])) return true; // fat Mach-O / java class
  if (ascii(head, 0, 15) === "SQLite format 3") return true;
  if (ascii(head, 0, 3) === "ID3") return true; // mp3
  if (ascii(head, 0, 4) === "OggS") return true;
  if (ascii(head, 0, 4) === "fLaC") return true;
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return true;
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "AVI ") return true;
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return true; // matroska/webm
  if (ascii(head, 4, 4) === "ftyp") return true; // remaining ISO-BMFF = video
  if (startsWith(head, [0x00, 0x61, 0x73, 0x6d])) return true; // wasm
  if (ascii(head, 0, 4) === "OTTO" || startsWith(head, [0x00, 0x01, 0x00, 0x00, 0x00])) return true; // fonts
  if (ascii(head, 0, 4) === "wOFF" || ascii(head, 0, 4) === "wOF2") return true;
  return false;
}

/**
 * Decide what one picked/dropped/pasted file is. `mime` is the browser's own
 * `File.type`, which is empty surprisingly often (drag from an archive tool,
 * a paste from some apps) — hence the magic bytes and the extension.
 */
export function classifyFile(name: string, mime: string, head: Uint8Array): Classification {
  const ext = extensionOf(name);
  const type = mime.toLowerCase();

  // 1. Documents the server refuses. Magic first, so a .pdf renamed to .txt
  //    still gets the PDF workaround rather than a generic failure.
  const magicFormat = documentByMagic(head, ext);
  if (magicFormat) return { ok: false, reason: "document", format: magicFormat };
  const extFormat = DOCUMENT_BY_EXTENSION[ext];
  if (extFormat) return { ok: false, reason: "document", format: extFormat };

  // 2. SVG is markup, not pixels: the canvas downscale below cannot size it
  //    reliably and the model would get a picture of nothing.
  if (ext === "svg" || type === "image/svg+xml") return { ok: false, reason: "unsupported" };

  // 3. Rasters. Anything the browser can decode is fine — we re-encode to
  //    webp on the way out, so the server only ever sees webp/png/jpeg.
  if (imageByMagic(head)) return { ok: true, kind: "image" };
  if (type.startsWith("image/")) return { ok: true, kind: "image" };
  if (IMAGE_EXTENSIONS.has(ext)) return { ok: true, kind: "image" };

  // 4. Other binary containers — no workaround worth naming.
  if (binaryByMagic(head)) return { ok: false, reason: "unsupported" };

  // 5. A NUL byte in the head means this was never text.
  if (head.includes(0)) return { ok: false, reason: "undecodable" };

  return { ok: true, kind: "text" };
}
