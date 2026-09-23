/**
 * Uploaded documents: the write half of RAG.
 *
 * Reading happens through the MCP server during a conversation; nothing here
 * searches. What these routes do is take a file, cut it into chunks, and put it
 * in the engine under a permission — and take it back out again.
 *
 * TWO STORES, ONE ORDER. The text and its metadata live here on disk; the
 * chunks live in the engine. Every operation writes the metadata FIRST and the
 * engine second, so an interruption leaves a document this app knows about and
 * can clean up. The reverse order leaves chunks in the engine that nothing
 * remembers, which no amount of retrying finds.
 */
import crypto from "node:crypto";
import express, { Router } from "express";
import { config } from "../config.js";
import { isValidId } from "../storage/paths.js";
import { getUser } from "../storage/userStore.js";
import { withLock } from "../storage/mutex.js";
import { sniffAttachment } from "../attachments/sniff.js";
import { pdfToText } from "../rag/pdf.js";
import {
  deleteDocumentFiles,
  getDocument,
  listDocuments,
  readDocumentChunks,
  findSharedDocument,
  listSharedDocuments,
  type OwnedRagDocument,
  documentSourcePath,
  readDocumentText,
  saveDocumentChunks,
  saveDocumentMeta,
  saveDocumentSource,
  saveDocumentText,
} from "../storage/documentStore.js";
import { RagEngineError, countChunks, indexDocument, ragConfigured, reindexScope, removeDocument } from "../rag/engineIndex.js";
import { describeReport, preprocess } from "../rag/preprocess.js";
import { partName, splitForIndexing } from "../rag/split.js";
import type { RagDocument, RagDocumentScope, SharedRagDocument } from "../types.js";

export const documentsRouter = Router();

const FALLBACK_NAME = "문서";
const MAX_NAME_CHARS = 200;

/**
 * The filename arrives percent-encoded in the query string for the same reason
 * it does on attachments: headers are latin-1 and would turn a Korean filename
 * into mojibake. Stored paths are built from server-generated ids only, so this
 * is display metadata — but it is also the chunk TITLE the model quotes, which
 * is why control characters are stripped rather than merely escaped.
 */
function safeName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return FALLBACK_NAME;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const segment = decoded.split(/[/\\]/).pop() ?? "";
  const cleaned = segment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, MAX_NAME_CHARS) || FALLBACK_NAME;
}

/** 업로드 중에 흘려보내는 것들. 화면이 진행 막대와 알림을 그리는 근거다. */
type UploadEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "split"; total: number; message: string }
  | { type: "part"; index: number; total: number; name: string; message: string }
  | { type: "chunks"; index: number; indexed: number; total: number; message: string }
  | { type: "indexed"; index: number; total: number; document: RagDocument }
  | { type: "done"; documents: RagDocument[]; error?: string }
  | { type: "failed"; code: DocumentErrorCode; error: string };

type DocumentErrorCode =
  | "not_configured"
  | "unsupported_type"
  | "too_large"
  | "not_found"
  | "no_source"
  | "invalid_input"
  | "index_failed";

function fail(res: express.Response, status: number, code: DocumentErrorCode, error: string) {
  res.status(status).json({ error, code });
}

/**
 * Indexing is serialised per account.
 *
 * Not a rate limit — a queue. The engine embeds every chunk as it indexes, so
 * two uploads at once do not go twice as fast; they contend for the same
 * embedder and both get slower. One at a time per person keeps the cost of a
 * large upload paid by the person who asked for it.
 */
function indexLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`rag:${ownerId}`, fn);
}

function requireEnabled(res: express.Response): boolean {
  if (ragConfigured()) return true;
  fail(res, 503, "not_configured", "문서 색인이 이 서버에 설정되어 있지 않습니다. 관리자에게 알려 주세요.");
  return false;
}

/** What the page needs to render itself, including why it might be empty. */
documentsRouter.get("/documents", async (req, res, next) => {
  try {
    if (!ragConfigured()) {
      return res.json({ enabled: false, maxBytes: config.ragDocMaxBytes, documents: [], shared: [] });
    }
    const [mine, shared] = await Promise.all([listDocuments(req.ownerId), listSharedDocuments()]);
    res.json({
      enabled: true,
      maxBytes: config.ragDocMaxBytes,
      documents: mine,
      // 공개 문서는 이미 모두의 검색에 걸린다 — 화면에 없을 뿐이었다.
      // 등록자를 함께 보내서 "이 내용이 어디서 왔는지" 를 물어볼 데를 만든다.
      shared: await withOwnerNames(shared),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 계정 id 에 이름을 붙인다. 이름이 없으면(계정이 지워졌다면) id 만 남는다 —
 * 지어내지 않는다. 같은 소유자가 여러 문서를 올렸어도 계정은 한 번만 읽는다.
 */
async function withOwnerNames(docs: OwnedRagDocument[]): Promise<SharedRagDocument[]> {
  const names = new Map<string, string>();
  for (const ownerId of new Set(docs.map((d) => d.ownerId))) {
    const user = await getUser(ownerId).catch(() => null);
    if (user) names.set(ownerId, user.name);
  }
  return docs.map((d) => ({ ...d, ownerName: names.get(d.ownerId) ?? null }));
}

/**
 * 업로드. 진행 상황을 흘려보내면서 색인한다.
 *
 * 한 번에 답하지 않고 SSE 로 보내는 이유는 이 요청이 느리기 때문이다 —
 * 글자를 꺼내고, 모델에게 경계를 묻고, 청크마다 벡터를 만든다. 예전에는 그
 * 십수 초 동안 화면에 "색인 중…" 한 줄뿐이었고, 실패해도 목록 맨 위에만
 * 뜨는 배너라 스크롤이 내려가 있으면 아무 일도 없던 것처럼 보였다.
 *
 * 한도를 넘으면 거절하지 않고 나눈다. 한도의 이유는 색인이 동기라는 것이고
 * 그건 문서 하나에 대한 제약이지, 사람이 가진 자료에 대한 제약이 아니다.
 */
documentsRouter.post(
  "/documents",
  // Route-scoped, and this router is mounted before the global JSON parser:
  // the declared Content-Type is a hint here, and a document that happens to be
  // JSON must arrive as bytes rather than as a parsed body.
  // PDF 는 파일이 훨씬 크므로(글자는 그 일부다) 파서 한도는 큰 쪽에 맞춘다.
  express.raw({ type: () => true, limit: Math.max(config.ragDocMaxBytes, config.ragPdfMaxBytes) }),
  async (req, res, next) => {
    /** 진행 상황을 보낼 수 있게 열렸는가. 열기 전의 실패는 평범한 JSON 오류다. */
    let streaming = false;
    const open = () => {
      if (streaming) return;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no"); // 앞단 프록시가 모아 두지 않도록
      res.flushHeaders?.();
      streaming = true;
    };
    const send = (event: UploadEvent) => {
      open();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      if (!requireEnabled(res)) return;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return fail(res, 400, "unsupported_type", "빈 요청입니다. 파일 본문을 그대로 보내 주세요.");
      }
      if (!isPdf(body) && body.length > config.ragDocMaxBytes) {
        return fail(res, 413, "too_large", tooLargeMessage());
      }

      const requested = readScope(req.query.scope);
      if (requested === null) return fail(res, 400, "invalid_input", "공개 범위는 private 또는 shared 여야 합니다.");
      const scope: RagDocumentScope = requested ?? "private";
      const baseName = safeName(req.query.name);

      // PDF 는 먼저 글자를 꺼낸 다음 나머지와 같은 길을 간다. 첨부파일 쪽
      // sniffer 는 PDF 를 거부하는데, 그 판단은 "모델에게 그림으로 보여
      // 줘야 하는가" 이고 여기서 묻는 것은 "검색할 글자가 있는가" 다.
      let text: string;
      let mime: string;
      if (isPdf(body)) {
        if (body.length > config.ragPdfMaxBytes) return fail(res, 413, "too_large", tooLargePdfMessage());
        send({ type: "stage", stage: "extract", message: "PDF 에서 글자를 꺼내는 중…" });
        text = extractPdf(body);
        mime = "application/pdf";
        if (text.trim().length < MIN_PDF_CHARS) {
          return streaming
            ? sendFail(res, "unsupported_type", NO_TEXT_IN_PDF)
            : fail(res, 415, "unsupported_type", NO_TEXT_IN_PDF);
        }
      } else {
        const sniffed = sniffAttachment(body, {
          maxImageBytes: config.ragDocMaxBytes,
          maxTextBytes: config.ragDocMaxBytes,
        });
        if (!sniffed.ok) return fail(res, sniffed.status, "unsupported_type", sniffed.message);
        if (sniffed.kind !== "text") {
          return fail(res, 415, "unsupported_type", "이미지는 색인할 수 없습니다. 글자가 담긴 .txt·.md·.csv·.pdf 파일을 올려 주세요.");
        }
        text = sniffed.text;
        mime = sniffed.mime;
      }

      // 어디서 왔든 여기서 본문만 남긴다. 쪽번호·깨진 줄·보이지 않는 글자를
      // 달고 청킹에 들어가면 그 청크는 검색에도 안 걸리고 답에도 못 쓴다.
      // 나누기 **전에** 하는 이유는, 덜어내고 나면 조각이 줄어들기 때문이다.
      const cleaned = preprocess(text, { paged: mime === "application/pdf" });
      const summary = describeReport(cleaned.report);
      if (summary) {
        console.log(`[documents] 전처리 "${baseName}": ${summary}`);
        send({ type: "stage", stage: "clean", message: `본문을 다듬는 중… (${summary})` });
      }
      text = cleaned.text;

      // 한도를 넘으면 나눈다. 한도 안이면 한 조각이고 이름도 그대로다.
      const parts = splitForIndexing(text, config.ragDocMaxBytes);
      if (parts.length > 1) {
        send({
          type: "split",
          total: parts.length,
          message: `글자가 ${text.length.toLocaleString("ko-KR")}자라 ${parts.length}개로 나누어 색인합니다.`,
        });
      }

      const stored: RagDocument[] = [];
      const failures: string[] = [];
      for (const part of parts) {
        const name = partName(baseName, part.index, part.total);
        send({ type: "part", index: part.index, total: parts.length, name, message: `${name} 색인 중…` });

        const now = new Date().toISOString();
        const meta: RagDocument = {
          id: `doc_${crypto.randomBytes(6).toString("hex")}`,
          name,
          mime,
          bytes: Buffer.byteLength(part.text, "utf8"),
          chars: part.text.length,
          // Counted before indexing, and written before indexing: the only
          // record of what to remove if the engine stops halfway.
          chunks: countChunks(part.text),
          chunkedBy: "rule",
          scope,
          status: "failed",
          error: "색인이 아직 끝나지 않았습니다.",
          createdAt: now,
          updatedAt: now,
        };
        if (meta.chunks === 0) continue; // 공백만 남은 조각. 나눌 때 생길 수 있다.

        // Text first: runIndex writes the metadata, and metadata pointing at
        // text that is not on disk yet is a document no retry could ever fix.
        await saveDocumentText(req.ownerId, meta.id, part.text);
        // 출처 "[n]" 을 누르면 이 원본을 그대로 띄운다(GET /documents/:id/file).
        if (mime === "application/pdf") await saveDocumentSource(req.ownerId, meta.id, body);
        const done = await indexLock(req.ownerId, () =>
          runIndex(req.ownerId, meta, part.text, {
            previousChunks: 0,
            // 조각이 하나뿐인 문서는 이것 말고 진행을 알릴 방법이 없다 —
            // 687청크를 16초 동안 말없이 넣는 것과 같아진다.
            onProgress: (indexed, total) =>
              send({ type: "chunks", index: part.index, indexed, total, message: `${total}개 단락 중 ${indexed}개 색인…` }),
          }),
        );
        stored.push(done);
        if (done.status === "failed") failures.push(`${name}: ${done.error ?? "색인 실패"}`);
        send({ type: "indexed", index: part.index, total: parts.length, document: done });
      }

      if (stored.length === 0) {
        const message = "문서에서 색인할 내용을 찾지 못했습니다. 빈 파일이거나 공백뿐입니다.";
        return streaming ? sendFail(res, "unsupported_type", message) : fail(res, 400, "unsupported_type", message);
      }
      send({
        type: "done",
        documents: stored,
        ...(failures.length > 0 ? { error: `${failures.length}개 조각의 색인이 실패했습니다 — ${failures[0]}` } : {}),
      });
      res.end();
    } catch (err) {
      if (streaming) {
        // 헤더가 이미 나갔으므로 상태 코드를 바꿀 수 없다. 이벤트로 알린다.
        sendFail(res, "index_failed", err instanceof Error ? err.message : String(err));
        return;
      }
      next(err);
    }
  },
);

/** 스트림이 열린 뒤의 실패. 상태 코드 대신 이벤트로 간다. */
function sendFail(res: express.Response, code: DocumentErrorCode, error: string): void {
  res.write(`data: ${JSON.stringify({ type: "failed", code, error })}\n\n`);
  res.end();
}

/** Publish or unpublish. Both are a re-index, because the permission is a field on every chunk. */
documentsRouter.patch("/documents/:id", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    if (!requireEnabled(res)) return;
    const doc = await loadOwn(req.ownerId, req.params.id);
    if (!doc) return fail(res, 404, "not_found", "존재하지 않는 문서입니다.");

    const scope = readScope((req.body as { scope?: unknown } | undefined)?.scope);
    if (scope === null || scope === undefined) {
      return fail(res, 400, "invalid_input", "공개 범위는 private 또는 shared 여야 합니다.");
    }

    // 색인이 이미 끝난 문서는 청크를 그대로 두고 권한만 바꾼다 — 문서가
    // 조금도 안 바뀌었는데 매번 처음부터(특히 LLM 청킹을) 다시 하는 것은
    // 낭비이고, 큰 문서일수록 그 낭비가 응답 없는 수십 초로 불어난다.
    // 실패했던 문서만 원문부터 다시 자르는 아래 경로로 간다 — 그 문서는
    // 지금 청크가 마지막 성공분과 같다는 보장이 없기 때문이다.
    const existingChunks = doc.status === "ready" ? await readDocumentChunks(req.ownerId, doc.id) : null;
    // 저장된 청크 수가 색인 때 기록한 수와 같을 때만 빠른 경로를 탄다. 권한이 걸린
    // 자리라서다: 빠른 경로는 같은 DOCID 를 덮어쓸 뿐 지우지 않으므로, 수가 모자라면
    // 남은 옛 청크가 **이전 권한 그대로** 검색에 걸린다 — 공개→비공개 전환에서
    // 그것은 비공개 문서가 모두에게 보인다는 뜻이다. 어긋나면 옛 청크를 기록된 수만큼
    // 지우고 다시 넣는 아래의 전체 경로로 간다.
    if (existingChunks && existingChunks.length > 0 && existingChunks.length === doc.chunks) {
      const chunkTexts = existingChunks.map((c) => (typeof c === "string" ? c : c.text));
      try {
        await indexLock(req.ownerId, () =>
          reindexScope({ docId: doc.id, ownerId: req.ownerId, title: doc.name, scope, chunkTexts }),
        );
      } catch (err) {
        const message = err instanceof RagEngineError ? err.message : err instanceof Error ? err.message : String(err);
        return res.status(502).json({ error: message, code: "index_failed", document: doc });
      }
      const updated: RagDocument = { ...doc, scope, updatedAt: new Date().toISOString() };
      await saveDocumentMeta(req.ownerId, updated);
      return res.json({ document: updated });
    }

    const text = await readDocumentText(req.ownerId, doc.id);
    if (text === null) return fail(res, 404, "not_found", "문서 원문을 찾을 수 없습니다.");

    const stored = await indexLock(req.ownerId, () =>
      runIndex(req.ownerId, { ...doc, scope, chunks: countChunks(text) }, text, { previousChunks: doc.chunks }),
    );
    if (stored.status === "failed") {
      return res.status(502).json({ error: stored.error, code: "index_failed", document: stored });
    }
    res.json({ document: stored });
  } catch (err) {
    next(err);
  }
});

/** Try again after a failed index. The source text is still here, so this costs nothing to offer. */
documentsRouter.post("/documents/:id/retry", async (req, res, next) => {
  try {
    if (!requireEnabled(res)) return;
    const doc = await loadOwn(req.ownerId, req.params.id);
    if (!doc) return fail(res, 404, "not_found", "존재하지 않는 문서입니다.");

    const text = await readDocumentText(req.ownerId, doc.id);
    if (text === null) return fail(res, 404, "not_found", "문서 원문을 찾을 수 없습니다.");

    const stored = await indexLock(req.ownerId, () =>
      runIndex(req.ownerId, { ...doc, chunks: countChunks(text) }, text, { previousChunks: doc.chunks }),
    );
    if (stored.status === "failed") {
      return res.status(502).json({ error: stored.error, code: "index_failed", document: stored });
    }
    res.json({ document: stored });
  } catch (err) {
    next(err);
  }
});

/**
 * The source text, for the viewer.
 *
 * Plain text rather than JSON: it can be hundreds of kilobytes, and wrapping it
 * in a JSON string would make the server escape every newline and the browser
 * unescape them again for no gain.
 */
documentsRouter.get("/documents/:id/text", async (req, res, next) => {
  try {
    const found = await loadReadable(req.ownerId, req.params.id);
    if (!found) return fail(res, 404, "not_found", "존재하지 않는 문서입니다.");
    const { ownerId, doc } = found;
    const text = await readDocumentText(ownerId, doc.id);
    if (text === null) return fail(res, 404, "not_found", "문서 원문을 찾을 수 없습니다.");
    res.type("text/plain; charset=utf-8").send(text);
  } catch (err) {
    next(err);
  }
});

/**
 * 올린 PDF 원본. 답변의 출처 "[n]" 을 누르면 오른쪽 창이 이것을 띄운다.
 *
 * 볼 수 있는 사람은 /text 와 같다(loadReadable: 내 문서, 또는 공개 문서). PDF 가
 * 아닌 문서와 원본을 보관하기 전에 올린 문서는 404 `no_source` — 화면은 그때
 * 원문 텍스트로 대신 보여 준다.
 */
documentsRouter.get("/documents/:id/file", async (req, res, next) => {
  try {
    const found = await loadReadable(req.ownerId, req.params.id);
    if (!found) return fail(res, 404, "not_found", "존재하지 않는 문서입니다.");
    const file = await documentSourcePath(found.ownerId, found.doc.id);
    if (!file) return fail(res, 404, "no_source", "이 문서는 PDF 원본이 보관되어 있지 않습니다.");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(found.doc.name)}`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

/** The chunks exactly as indexed, so the viewer can show where the cuts fell. */
documentsRouter.get("/documents/:id/chunks", async (req, res, next) => {
  try {
    const found = await loadReadable(req.ownerId, req.params.id);
    if (!found) return fail(res, 404, "not_found", "존재하지 않는 문서입니다.");
    const { ownerId, doc } = found;
    // Absent for a document indexed before chunks were kept, and for one whose
    // index failed. Neither is an error — there is simply nothing to show.
    //
    // Two shapes exist on disk: the first sidecars were plain strings, later
    // ones carry the overlap length too. Normalising here rather than in the
    // page keeps the older documents readable without re-indexing them.
    const stored = (await readDocumentChunks(ownerId, doc.id)) ?? [];
    const chunks = stored.map((c) =>
      typeof c === "string" ? { text: c, overlapLen: 0 } : { text: c.text, overlapLen: c.overlapLen ?? 0 },
    );
    res.json({ chunks, chunkedBy: doc.chunkedBy ?? "rule" });
  } catch (err) {
    next(err);
  }
});

documentsRouter.delete("/documents/:id", async (req, res, next) => {
  try {
    if (!requireEnabled(res)) return;
    const doc = await loadOwn(req.ownerId, req.params.id);
    if (!doc) return res.status(204).end(); // already gone is the outcome asked for

    // Engine first. The other order leaves a document that has vanished from
    // the page but still answers searches, with nothing left to delete it by.
    await indexLock(req.ownerId, () => removeDocument(doc.id, doc.chunks));
    await deleteDocumentFiles(req.ownerId, doc.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof RagEngineError) {
      return fail(res, 502, "index_failed", `검색 색인에서 지우지 못해 중단했습니다: ${err.message}`);
    }
    next(err);
  }
});

/** `%PDF-` 로 시작하는가. 확장자가 아니라 바이트로 가린다 — 이름은 누구나 바꾼다. */
function isPdf(buf: Buffer): boolean {
  return buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** 글자가 이보다 적으면 스캔본으로 본다. 쪽 번호 몇 개로 "글이 있다" 고 할 수는 없다. */
const MIN_PDF_CHARS = 200;

const NO_TEXT_IN_PDF =
  "이 PDF 에서 글자를 찾지 못했습니다. 종이를 스캔해 넣은 문서이거나 내용이 전부 그림입니다 — " +
  "그런 파일은 글자가 아니라 사진이라 검색할 수 없습니다. 글자로 된 PDF 이거나 .txt·.md 파일이면 됩니다.";

function extractPdf(buf: Buffer): string {
  try {
    return pdfToText(buf);
  } catch {
    // 깨진 PDF 한 건이 업로드 전체를 500 으로 만들 이유가 없다. 글자가
    // 없는 것과 같이 취급하면 사용자가 읽을 수 있는 설명이 나간다.
    return "";
  }
}

function tooLargePdfMessage(): string {
  return `PDF 가 너무 큽니다. ${Math.round(config.ragPdfMaxBytes / (1024 * 1024))}MB까지 올릴 수 있습니다.`;
}

function tooLargeMessage(): string {
  const kb = Math.round(config.ragDocMaxBytes / 1024);
  return `문서가 너무 큽니다. ${kb}KB까지 올릴 수 있습니다. 나누어 올려 주세요.`;
}

/** `undefined` = not given, `null` = given but not a scope. Kept apart because they mean different answers. */
function readScope(raw: unknown): RagDocumentScope | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "private" || raw === "shared") return raw;
  return null;
}

async function loadOwn(ownerId: string, id: unknown): Promise<RagDocument | null> {
  if (typeof id !== "string" || !isValidId(id)) return null;
  return getDocument(ownerId, id);
}

/**
 * **읽을 수 있는** 문서를 찾는다: 내 것이거나, 누군가 공개한 것.
 *
 * 고치거나 지우는 길(PATCH·DELETE·retry)은 여전히 loadOwn 만 쓴다 — 읽는 것과
 * 바꾸는 것은 다른 권한이고, 공개했다는 것이 남이 고쳐도 된다는 뜻은 아니다.
 */
async function loadReadable(
  ownerId: string,
  id: unknown,
): Promise<{ ownerId: string; doc: RagDocument } | null> {
  const own = await loadOwn(ownerId, id);
  if (own) return { ownerId, doc: own };
  if (typeof id !== "string") return null;
  const shared = await findSharedDocument(id);
  return shared ? { ownerId: shared.ownerId, doc: shared } : null;
}

/**
 * Index, and record what happened either way.
 *
 * A failure is STORED, not just returned: the document stays on the page marked
 * as failed, with its text kept, so it can be retried or removed. Throwing away
 * the upload because the engine was busy would make the person do the work
 * again for a reason that had nothing to do with them.
 */
async function runIndex(
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
