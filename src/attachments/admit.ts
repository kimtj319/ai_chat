import type { AttachmentLimits } from "../api/types";
import type { AttachSource, DraftAttachment } from "../hooks/useAttachmentDraft";
import { classifyFile, HEAD_BYTES } from "./classify";
import {
  estimateImageTokens,
  estimateTextTokens,
  fitWithin,
  formatBytes,
  isGenericPastedName,
  MAX_SOURCE_IMAGE_BYTES,
  pastedImageName,
} from "./format";
import { decodeImage, type SourceImage } from "./imagePrepare";
import { downscaleEdge } from "./limits";
import * as copy from "./messages";
import type { NoticeSpec } from "./messages";
import { decodeText, TEXT_UPLOAD_MIME, utf8ByteLength } from "./textDecode";

/**
 * One file's verdict: refused with the notice to show, or admitted as the chip
 * to add. An admitted image carries its decoded bitmap (`probe`) for the
 * downscale; whoever drops the result must close it.
 */
export type Admission =
  | { refusal: NoticeSpec }
  | { seed: Omit<DraftAttachment, "localId">; probe?: SourceImage };

/**
 * Everything the draft checks before a chip exists: a file that cannot be sent
 * never gets a progress bar. `existingNames` is read after the head of the file
 * is in, so a pasted screenshot is named against the chips as they are then.
 */
export async function admit(
  file: File,
  source: AttachSource,
  existingNames: () => string[],
  active: AttachmentLimits,
): Promise<Admission> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const verdict = classifyFile(file.name, file.type, head);

  // A pasted screenshot always arrives as "image.png"; name it before
  // anything reports on it, collisions included.
  const name =
    source === "paste" && verdict.ok && verdict.kind === "image" && isGenericPastedName(file.name)
      ? pastedImageName(existingNames(), file.type)
      : file.name;

  if (!verdict.ok) return { refusal: copy.refusalNotice(verdict, name) };

  if (verdict.kind === "image") {
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      return { refusal: copy.tooLarge(name, formatBytes(MAX_SOURCE_IMAGE_BYTES), "image") };
    }
    // Decoded once, here: the dimensions are what the token gate needs
    // and the bitmap is handed straight to the downscale below.
    let probe: SourceImage;
    try {
      probe = await decodeImage(file);
    } catch {
      return { refusal: copy.undecodableImage(name) };
    }
    // The cost that matters is the one after the downscale, so a 24MP
    // photo is judged on the 2048px image the model will really see.
    const target = fitWithin(probe.width, probe.height, downscaleEdge(active));
    const tokens = estimateImageTokens(target.width, target.height);
    if (tokens > active.maxFileTokens) {
      probe.bitmap.close();
      return { refusal: copy.fileOverBudget(name, tokens, active.maxFileTokens) };
    }
    return {
      seed: {
        name,
        kind: "image",
        status: "preparing",
        bytes: file.size,
        estimatedTokens: tokens,
        mime: file.type,
        width: target.width,
        height: target.height,
        blob: file,
      },
      probe,
    };
  }

  const decoded = decodeText(new Uint8Array(await file.arrayBuffer()));
  if (!decoded) return { refusal: copy.undecodableText(name) };
  const tokens = estimateTextTokens(decoded.text);
  if (tokens > active.maxFileTokens) {
    return { refusal: copy.fileOverBudget(name, tokens, active.maxFileTokens) };
  }
  const bytes = utf8ByteLength(decoded.text);
  if (bytes > active.maxFileBytes) {
    return { refusal: copy.tooLarge(name, formatBytes(active.maxFileBytes), "text") };
  }
  return {
    seed: {
      name,
      kind: "text",
      status: "preparing",
      bytes,
      estimatedTokens: tokens,
      mime: TEXT_UPLOAD_MIME,
      text: decoded.text,
      // Uploaded as UTF-8 whatever the file's own encoding was, so the
      // server never has to know about CP949.
      blob: new Blob([decoded.text], { type: TEXT_UPLOAD_MIME }),
    },
  };
}
