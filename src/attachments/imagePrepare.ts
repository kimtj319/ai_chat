// Client-side downscale. Mandatory, not an optimization: the server cannot
// resize (that needs an image decoder, i.e. a dependency), and doing it here
// is what makes the token number on the chip the number the model is billed.

import { fitWithin } from "./format";

/** webp at this quality is visually lossless for screenshots at 2048px. */
const WEBP_QUALITY = 0.85;
const WEBP_MIME = "image/webp";

/** Formats we hand through untouched when no resize is needed. */
const KEEP_AS_IS = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface SourceImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Decode just far enough to learn the real pixel size. `imageOrientation:
 * "from-image"` is load-bearing — without it an EXIF-rotated phone photo
 * reaches the model sideways, and its width/height come back swapped, so the
 * token estimate would be right for the wrong picture.
 */
export async function decodeImage(file: Blob): Promise<SourceImage> {
  if (typeof createImageBitmap !== "function") throw new Error("createImageBitmap unavailable");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

async function encode(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context) {
      context.drawImage(source, 0, 0, width, height);
      return canvas.convertToBlob({ type: WEBP_MIME, quality: WEBP_QUALITY });
    }
  }

  // Safari before 17 has no OffscreenCanvas.convertToBlob.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d context unavailable");
  context.drawImage(source, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      WEBP_MIME,
      WEBP_QUALITY,
    );
  });
}

/**
 * Downscale `file` so its longest edge is at most `edge`, re-encoding to webp.
 * A file that is already within bounds and already in a format the model reads
 * is passed through untouched — re-encoding a 40KB screenshot only loses
 * fidelity and gains nothing.
 *
 * `source` is the bitmap from `decodeImage`; it is closed here either way.
 */
export async function prepareImage(file: File, source: SourceImage, edge: number): Promise<PreparedImage> {
  const target = fitWithin(source.width, source.height, edge);
  const unchanged = target.width === source.width && target.height === source.height;

  try {
    if (unchanged && KEEP_AS_IS.has(file.type.toLowerCase())) {
      return { blob: file, width: source.width, height: source.height };
    }

    // The resize pass the platform can do best, with the canvas below sized to
    // the same target: some Safari builds ignore createImageBitmap's resize
    // options, and drawImage's explicit width/height is what makes the result
    // correct anyway.
    let drawFrom: CanvasImageSource = source.bitmap;
    let resized: ImageBitmap | null = null;
    if (!unchanged) {
      try {
        resized = await createImageBitmap(file, {
          ...(source.width >= source.height ? { resizeWidth: target.width } : { resizeHeight: target.height }),
          resizeQuality: "high",
          imageOrientation: "from-image",
        });
        drawFrom = resized;
      } catch {
        // Fall back to scaling the full-size bitmap on the canvas.
      }
    }

    try {
      const blob = await encode(drawFrom, target.width, target.height);
      // A tiny PNG can encode *larger* as webp; keep whichever is smaller when
      // no resize happened.
      if (unchanged && blob.size >= file.size && KEEP_AS_IS.has(file.type.toLowerCase())) {
        return { blob: file, width: source.width, height: source.height };
      }
      return { blob, width: target.width, height: target.height };
    } finally {
      resized?.close();
    }
  } finally {
    source.bitmap.close();
  }
}
