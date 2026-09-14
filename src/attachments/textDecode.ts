// Text attachments are decoded here, on the client, and uploaded as UTF-8 —
// so the server never has to know that a CSV exported from Excel on Korean
// Windows is CP949. Both decoders are native; no dependency is added.

export interface DecodedText {
  text: string;
  encoding: "utf-8" | "euc-kr";
}

/** What the client uploads text as, whatever the file's own encoding was. */
export const TEXT_UPLOAD_MIME = "text/plain; charset=utf-8";

const NUL_SCAN_BYTES = 8192;

function stripBom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

/**
 * UTF-8 first (fatal, so a mis-guess is an exception rather than a page of
 * U+FFFD), then EUC-KR — which the Encoding Standard maps to the full CP949
 * table, i.e. the encoding Excel writes on a Korean Windows box.
 *
 * Returns null when the bytes are not text at all: a NUL in the first 8 KB,
 * or neither decoder producing clean output.
 */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  const head = bytes.subarray(0, NUL_SCAN_BYTES);
  if (head.includes(0)) return null;

  const body = stripBom(bytes);

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    // Not UTF-8 — fall through to the CP949 attempt below.
  }

  try {
    const text = new TextDecoder("euc-kr").decode(body);
    // euc-kr is non-fatal by spec, so an undecodable byte surfaces as U+FFFD
    // rather than throwing. That is our "neither decodes" signal.
    if (text.includes("�")) return null;
    return { text, encoding: "euc-kr" };
  } catch {
    return null;
  }
}

/** UTF-8 byte length of the string we are about to upload. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
