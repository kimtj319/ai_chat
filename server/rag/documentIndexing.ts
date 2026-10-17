/**
 * Indexing for the 문서 routes (routes/documents.ts): the per-account queue,
 * the index-and-record step, and the checks an upload goes through first.
 */
import { config } from "../config.js";
import { withLock } from "../storage/mutex.js";
import { saveDocumentChunks, saveDocumentMeta } from "../storage/documentStore.js";
import type { RagDocument, RagDocumentScope } from "../types.js";
import { indexDocument } from "./engineIndex.js";
import { pdfToText } from "./pdf.js";

/**
 * Indexing is serialised per account.
 *
 * Not a rate limit — a queue. The engine embeds every chunk as it indexes, so
 * two uploads at once do not go twice as fast; they contend for the same
 * embedder and both get slower. One at a time per person keeps the cost of a
 * large upload paid by the person who asked for it.
 */
export function indexLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`rag:${ownerId}`, fn);
}

/** `%PDF-` 로 시작하는가. 확장자가 아니라 바이트로 가린다 — 이름은 누구나 바꾼다. */
export function isPdf(buf: Buffer): boolean {
  return buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** 글자가 이보다 적으면 스캔본으로 본다. 쪽 번호 몇 개로 "글이 있다" 고 할 수는 없다. */
export const MIN_PDF_CHARS = 200;

export const NO_TEXT_IN_PDF =
  "이 PDF 에서 글자를 찾지 못했습니다. 종이를 스캔해 넣은 문서이거나 내용이 전부 그림입니다 — " +
  "그런 파일은 글자가 아니라 사진이라 검색할 수 없습니다. 글자로 된 PDF 이거나 .txt·.md 파일이면 됩니다.";

export function extractPdf(buf: Buffer): string {
  try {
    return pdfToText(buf);
  } catch {
    // 깨진 PDF 한 건이 업로드 전체를 500 으로 만들 이유가 없다. 글자가
    // 없는 것과 같이 취급하면 사용자가 읽을 수 있는 설명이 나간다.
    return "";
  }
}

export function tooLargePdfMessage(): string {
  return `PDF 가 너무 큽니다. ${Math.round(config.ragPdfMaxBytes / (1024 * 1024))}MB까지 올릴 수 있습니다.`;
}

export function tooLargeMessage(): string {
  const kb = Math.round(config.ragDocMaxBytes / 1024);
  return `문서가 너무 큽니다. ${kb}KB까지 올릴 수 있습니다. 나누어 올려 주세요.`;
}

/** `undefined` = not given, `null` = given but not a scope. Kept apart because they mean different answers. */
export function readScope(raw: unknown): RagDocumentScope | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "private" || raw === "shared") return raw;
  return null;
}

/**
 * Index, and record what happened either way.
 *
 * A failure is STORED, not just returned: the document stays on the page marked
 * as failed, with its text kept, so it can be retried or removed. Throwing away
 * the upload because the engine was busy would make the person do the work
 * again for a reason that had nothing to do with them.
 */
export async function runIndex(
  ownerId: string,
  meta: RagDocument,
  text: string,
  { previousChunks, onProgress }: { previousChunks: number; onProgress?: (done: number, total: number) => void },
): Promise<RagDocument> {
  const pending: RagDocument = { ...meta, status: "failed", error: "색인이 아직 끝나지 않았습니다.", updatedAt: new Date().toISOString() };
  await saveDocumentMeta(ownerId, pending);
  try {
    const result = await indexDocument({
      docId: meta.id,
      ownerId,
      title: meta.name,
      text,
      scope: meta.scope,
      previousChunks,
      ...(onProgress ? { onProgress } : {}),
    });
    // The chunk bodies are kept so the viewer can show what was actually
    // indexed. Re-cutting the text later would not reproduce them when the
    // boundaries came from a model.
    await saveDocumentChunks(ownerId, meta.id, result.texts);
    const ready: RagDocument = {
      ...meta,
      // The real count, replacing the estimate written before indexing.
      chunks: result.chunks,
      chunkedBy: result.method,
      status: "ready",
      updatedAt: new Date().toISOString(),
    };
    delete ready.error;
    await saveDocumentMeta(ownerId, ready);
    return ready;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: RagDocument = { ...pending, error: message, updatedAt: new Date().toISOString() };
    await saveDocumentMeta(ownerId, failed);
    return failed;
  }
}
