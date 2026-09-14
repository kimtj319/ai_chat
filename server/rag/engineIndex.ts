/**
 * Everything this application knows about the search engine, in one file.
 *
 * The engine is a WRITE target here and nothing else: reading is the MCP
 * server's job (it owns the query shape, the vector field, the snippets), and
 * duplicating that here would give one feature two sources of truth about what
 * a search means. What this file owns is the other half — turning an uploaded
 * document into chunks the engine can hold, and taking them away again.
 *
 * PERMISSIONS ARE THE POINT. A chunk carries `ACL`, and that value is a KEY,
 * not an account: who may read the key is decided by the engine's authority
 * table (`/authorities/{collection}`), not by the document. So indexing a
 * private document is two writes — the chunks, and the key that makes the owner
 * the only account holding it — and getting the second one wrong means a
 * document nobody can read, including its owner.
 */
import { config } from "../config.js";
import { chunkText, type Chunk } from "./chunk.js";
import { planChunks, type ChunkMethod } from "./llmChunk.js";

/** The shared corpus key. Must match RAG_SHARED_KEY on the MCP server. */
export const SHARED_KEY = "shared";

/** One person's private key. The only place this shape is decided. */
export function ownerKey(ownerId: string): string {
  return `u_${ownerId}`;
}

export type DocumentScope = "private" | "shared";

/**
 * The engine's own indexing deadline covers embedding every chunk in the
 * batch, so this has to be generous — it is not a latency budget, it is the
 * point at which we decide the socket is dead.
 */
const INDEX_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 15_000;

/**
 * Documents per index request. The engine embeds each chunk as it indexes, so a
 * batch is a unit of work, not a unit of bandwidth: 50 keeps one request's work
 * under a couple of seconds and keeps a failure from costing the whole document.
 */
const BATCH_SIZE = 50;

/** A failure the engine reported, carrying a message fit for a person. */
export class RagEngineError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "RagEngineError";
    this.status = status;
  }
}

export function ragConfigured(): boolean {
  return config.ragEngineUrl.length > 0;
}

function requireConfigured(): string {
  if (!config.ragEngineUrl) {
    throw new RagEngineError("문서 색인이 설정되지 않았습니다 (RAG_ENGINE_URL).");
  }
  return config.ragEngineUrl;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function call(path: string, { method = "POST", body, headers = {}, timeoutMs = CALL_TIMEOUT_MS }: CallOptions = {}): Promise<unknown> {
  const url = `${requireConfigured()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new RagEngineError(`검색 엔진이 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다.`);
    }
    throw new RagEngineError(`검색 엔진에 연결하지 못했습니다: ${(err as Error)?.message ?? err}`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Left null; the caller reports the raw text instead.
  }
  const reported = (parsed as { header?: { message?: string; status?: string } } | null)?.header;
  if (!res.ok) {
    throw new RagEngineError(`검색 엔진 오류: ${(reported?.message ?? text).trim().slice(0, 200)}`, res.status);
  }
  // A 200 can still carry the error envelope — the engine reports most refusals
  // that way, so checking the status code alone would read failure as success.
  if (reported?.status === "error") {
    throw new RagEngineError(`검색 엔진 오류: ${(reported.message ?? text).trim().slice(0, 200)}`);
  }
  return parsed;
}

/** `doc_<id>#000` — the id of one chunk. Kept here so nothing else has to know the shape. */
function chunkId(docId: string, ord: number): string {
  return `${docId}#${String(ord).padStart(3, "0")}`;
}

export interface IndexResult {
  chunks: number;
  elapsedMs: number;
  /** Who chose the boundaries. Shown in the list so a document cut before the model was configured is recognisable. */
  method: ChunkMethod;
  /** How many windows the model actually answered, for the log. */
  windows: { total: number; fromModel: number };
  /**
   * The chunks for the caller to keep, so the viewer can show them exactly as
   * indexed. `overlapLen` travels with them because the viewer needs to tell
   * the carried-over head from this chunk's own text — without it the overlap
   * reads as the same sentence printed twice.
   */
  texts: Array<{ text: string; overlapLen: number }>;
}

/**
 * A cheap upper bound on how many chunks this text will produce, recorded
 * BEFORE indexing so a run interrupted halfway can still be cleaned up.
 *
 * The rule-based count is used even when the model will pick the boundaries,
 * because the number is needed before any of that happens and its only job is
 * to be big enough. The real count replaces it once indexing has finished.
 */
export function countChunks(text: string): number {
  return chunkText(text).length;
}

/**
 * Replace this document's chunks in the engine.
 *
 * `previousChunks` is how many chunks the stored version had — the caller reads
 * it from its own metadata. Delete-then-index rather than index-over-the-top:
 * a document that got SHORTER would otherwise leave the extra chunks of the
 * previous version behind, searchable and orphaned, because nothing would ever
 * overwrite them.
 *
 * Deleting by explicit id rather than by query on purpose. The engine's query
 * delete matches through the analyzed fields, so a PARENT_ID query is a
 * morphological match and could reach documents it was never meant to — and
 * over-deleting here means destroying somebody else's document. The caller
 * already knows exactly which ids exist, so it names them.
 */
export async function indexDocument(params: {
  docId: string;
  ownerId: string;
  title: string;
  text: string;
  scope: DocumentScope;
  previousChunks: number;
  /** 배치가 하나 들어갈 때마다 불린다. 화면의 진행 막대가 이걸로 움직인다. */
  onProgress?: (done: number, total: number) => void;
}): Promise<IndexResult> {
  const { docId, ownerId, title, text, scope, previousChunks, onProgress } = params;
  const started = Date.now();
  const acl = scope === "shared" ? SHARED_KEY : ownerKey(ownerId);

  // The key first. A document indexed under a key no account holds is a
  // document its own owner cannot read, and the engine reports that as an
  // ordinary empty result rather than as the misconfiguration it is.
  if (scope === "private") await ensureOwnerKey(ownerId);

  await removeDocument(docId, previousChunks, { commit: false });

  // The boundaries may come from the model; the cutting never does. planChunks
  // falls back to the rule-based chunker per window, so this cannot fail for a
  // reason the uploader had any part in.
  const plan = await planChunks(text);
  const chunks: Chunk[] = plan.chunks;
  if (chunks.length === 0) {
    throw new RagEngineError("문서에서 색인할 내용을 찾지 못했습니다. 빈 파일이거나 공백뿐입니다.");
  }

  const collection = encodeURIComponent(config.ragCollection);
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => ({
      DOCID: chunkId(docId, c.ord),
      PARENT_ID: docId,
      TITLE: title,
      BODY: c.text,
      SOURCE: title,
      ORD: String(c.ord),
      ACL: acl,
      OWNER: ownerId,
      SCOPE: scope === "shared" ? "shared" : "user",
    }));
    const answer = (await call(`/index/${collection}`, {
      body: batch,
      headers: { commit: "false" },
      timeoutMs: INDEX_TIMEOUT_MS,
    })) as { result?: boolean; fail?: string[] } | null;
    // The engine answers 200 even when every document in the batch failed, so
    // the fail list is the only place a partial failure shows up.
    const failed = answer?.fail ?? [];
    if (failed.length > 0) {
      throw new RagEngineError(`${failed.length}개 조각을 색인하지 못했습니다 (${failed.slice(0, 3).join(", ")}).`);
    }
    onProgress?.(Math.min(i + BATCH_SIZE, chunks.length), chunks.length);
  }

  await commit();
  return {
    chunks: chunks.length,
    elapsedMs: Date.now() - started,
    method: plan.method,
    windows: plan.windows,
    texts: chunks.map((c) => ({ text: c.text, overlapLen: c.overlapLen })),
  };
}

/**
 * Take a document's chunks out of the engine.
 *
 * `chunks` is the count the caller recorded when it indexed — which it writes
 * BEFORE indexing, so that a run interrupted halfway still leaves behind a
 * number big enough to clean up by.
 *
 * Deleting ids that are not there is normal here: re-indexing clears a previous
 * version that may have been shorter, and cleanup after a failure names chunks
 * that were never written. The engine answers "nothing deleted at all" with a
 * 400, which in this operation means the work was already done, so that one is
 * swallowed; every other error is not.
 */
export async function removeDocument(
  docId: string,
  chunks: number,
  { commit: doCommit = true }: { commit?: boolean } = {},
): Promise<void> {
  if (chunks <= 0) return;
  const collection = encodeURIComponent(config.ragCollection);
  const ids = Array.from({ length: chunks }, (_, ord) => chunkId(docId, ord));
  try {
    await call(`/index/${collection}/delete`, { body: ids, headers: { commit: "false" }, timeoutMs: INDEX_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof RagEngineError) || err.status !== 400) throw err;
  }
  if (doCommit) await commit();
}

async function commit(): Promise<void> {
  await call(`/index/${encodeURIComponent(config.ragCollection)}/commit`, { timeoutMs: INDEX_TIMEOUT_MS });
}

interface AuthorityEntry {
  key: string;
  accounts: string[];
}

/**
 * Make sure this owner holds their own key, and nobody else does.
 *
 * `/update` replaces the whole entry for a key, which is exactly right for a
 * private key — it has one account by definition, so writing it is idempotent
 * and cannot widen. It would be the wrong call for the SHARED key, whose
 * accounts have to be read first and carried across; that one belongs to the
 * MCP server, which is where a reader first appears.
 */
async function ensureOwnerKey(ownerId: string): Promise<void> {
  const entry: AuthorityEntry = { key: ownerKey(ownerId), accounts: [ownerId] };
  await call(`/authorities/${encodeURIComponent(config.ragCollection)}/update`, { body: [entry] });
}

/**
 * Drop a departing owner's private key.
 *
 * Their documents are deleted separately; this removes the permission that
 * outlives them. Harmless if the key was never created — deleting by key does
 * not require the key to exist.
 *
 * Their entry on the SHARED key is deliberately left behind. Removing it would
 * mean reading that key's whole account list and writing it back, and the MCP
 * server does the same read-modify-write whenever a new reader appears: two
 * writers on one list lose each other's updates, and the update that gets lost
 * is somebody's access to the shared corpus. What is left instead is a name
 * that can no longer authenticate, holding a key to documents everyone can read
 * anyway — dead weight, not exposure.
 */
export async function removeOwnerKey(ownerId: string): Promise<void> {
  await call(`/authorities/${encodeURIComponent(config.ragCollection)}/delete`, {
    body: [{ key: ownerKey(ownerId) }],
  }).catch(() => {
    // A departing owner must not be blocked by permission bookkeeping. Their
    // documents are already gone by the time this runs, so a key left behind
    // grants access to nothing.
  });
}
