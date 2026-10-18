/**
 * 검색 색인에서 문서 하나를 다시 엮는다 — 출처 창이 원문을 보여 줄 길이 이것뿐인 문서용.
 *
 * 왜 필요한가: 답변의 "[n]" 은 엔진이 돌려준 단락을 가리킨다. 이 앱으로 올린 문서는
 * 원본이 디스크에 있지만, 엔진에 바로 넣은 시드 코퍼스(rag-server/ragkit/load.mjs)는
 * 이 앱이 원문을 가진 적이 없다. 그래서 출처 창은 검색된 단락 하나만 보여 줬고, 그
 * 단락이 문서의 어디쯤인지는 알 길이 없었다. 엔진에는 그 문서의 청크가 모두 있다.
 *
 * 요청 모양은 MCP 서버(rag-server/ragmcp/engine.mjs 의 buildFilterBody·rowsOf·toPassage)와
 * 같다. 권한도 같은 규칙이다: 엔진은 묻는 사람을 모르고 본문의 `authority.account` 를
 * 그대로 믿으므로, 계정은 로그인한 사람의 id 로만 채운다(MCP 에 X-Mcp-User 로 보내는
 * 값, 그리고 색인할 때 비공개 키 `u_<id>` 를 쥐여 주는 바로 그 계정이다).
 *
 * 하지 않는 것: 엔진에 계정을 등록하지 않는다. 공유 키의 계정 목록은 MCP 서버가 읽고
 * 고쳐 쓰는 것이라, 여기서도 쓰면 두 쓰기가 서로의 갱신을 잃는다(engineIndex.ts 의
 * removeOwnerKey 설명). 엔진이 모르는 계정은 엔진이 400 으로 답하고, 그건 "읽을 수 있는
 * 것이 없다" 와 같게 404 로 끝난다 — 더 보여 주는 쪽으로는 절대 기울지 않는다.
 */
import { config } from "../config.js";
import { RagEngineError, call } from "./engineIndex.js";

/** 청크가 권한 키를 담는 필드. indexDocument 가 `ACL` 로 쓰고, MCP 의 RAG_AUTHORITY_FIELD 와 같아야 한다. */
const AUTHORITY_FIELD = "ACL";

/** 한 문서에서 가져올 청크 수의 상한. MCP 의 PARENT_CHUNK_LIMIT 와 같다. */
export const PARENT_CHUNK_LIMIT = 200;

/**
 * filterQuery 는 `<FIELD:OP:VALUE>` 문법의 **문자열**이라, 끼워 넣는 값은 데이터가 아니라
 * 코드다. MCP 의 isFilterSafe 와 같은 규칙 — 한글 id(`03-커밋과-배치`)는 통과하고
 * `>`·`&`·공백은 막는다.
 */
const FILTER_SAFE_VALUE = /^[\p{L}\p{N}\p{M}._:@#/+-]{1,256}$/u;
/** MCP 가 받아 주는 계정 모양. 엔진 JSON 에 실려 그대로 비교된다. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

export interface EngineChunk {
  ord: number;
  text: string;
}

export interface RebuiltSource {
  parentId: string;
  title: string;
  /** 청크를 순서대로, 겹침을 빼고 이은 글. */
  text: string;
  /** 청크마다 text 안에서 차지하는 자리. 칠할 범위다 — 앞 청크와 겹친 꼬리까지 포함한다. */
  chunks: Array<{ ord: number; start: number; end: number }>;
  /** 상한에 걸려 일부만 가져왔는가. */
  truncated: boolean;
}

/** 여러 값 필드는 배열로 온다. MCP 의 asText 와 같다. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(" ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/** 아무것도 걸리지 않으면 `document` 가 아예 없다. */
function rowsOf(payload: unknown): Array<{ fields?: Record<string, unknown> }> {
  const document = (payload as { document?: unknown } | null)?.document;
  if (Array.isArray(document)) return document;
  const result = (document as { result?: unknown } | undefined)?.result;
  return Array.isArray(result) ? result : [];
}

/**
 * `next` 의 머리가 `prev` 의 꼬리를 이월한 겹침이면 그 길이(구분 줄바꿈 포함), 아니면 0.
 *
 * 겹침은 청커(chunk.ts 의 applyOverlap — 시드 로더의 ragkit/chunk.mjs 도 같다)가
 * `앞 청크 꼬리 + "\n" + 자기 본문` 으로 만든다. 엔진에는 그 길이(overlapLen)가 없으므로
 * 모양으로 알아본다: 줄바꿈 앞까지가 앞 청크의 끝과 글자 그대로 같은 가장 긴 머리.
 * 꼬리는 80자 안팎이라 넉넉히 1000자 안에서만 찾는다.
 */
export function overlapLength(prev: string, next: string): number {
  let best = 0;
  const limit = Math.min(next.length - 1, prev.length, 1000);
  for (let k = next.indexOf("\n"); k > 0 && k <= limit; k = next.indexOf("\n", k + 1)) {
    if (prev.endsWith(next.slice(0, k))) best = k + 1;
  }
  return best;
}

/**
 * 청크를 순서대로 잇는다. 이어진 순번 사이에서만 겹침을 뺀다 — 중간 청크가 빠졌으면
 * 앞 청크는 진짜 앞이 아니므로 겹칠 리 없다. 청크 경계는 대개 문단 경계라 빈 줄로 잇는다.
 */
export function joinChunks(chunks: EngineChunk[]): { text: string; ranges: RebuiltSource["chunks"] } {
  const sorted = [...chunks].sort((a, b) => a.ord - b.ord);
  let text = "";
  const ranges: RebuiltSource["chunks"] = [];
  sorted.forEach((chunk, i) => {
    const prev = sorted[i - 1];
    const overlap = prev && prev.ord === chunk.ord - 1 ? overlapLength(prev.text, chunk.text) : 0;
    const body = chunk.text.slice(overlap);
    if (text) text += "\n\n";
    const bodyStart = text.length;
    // 겹친 꼬리(구분 줄바꿈을 뺀 overlap-1 글자)는 앞 청크 끝에 이미 있다. 칠할 자리는 거기서 시작한다.
    const start = overlap > 0 ? Math.max(0, bodyStart - 2 - (overlap - 1)) : bodyStart;
    text += body;
    ranges.push({ ord: chunk.ord, start, end: text.length });
  });
  return { text, ranges };
}

/**
 * `parentId` 문서를 `account` 의 권한으로 읽는다. 읽을 수 있는 청크가 없으면 null.
 * 엔진이 연결·응답에 실패하면 RagEngineError 를 던진다(라우트가 502 로 바꾼다).
 */
export async function readSourceFromEngine(parentId: unknown, account: string): Promise<RebuiltSource | null> {
  if (typeof parentId !== "string" || !FILTER_SAFE_VALUE.test(parentId)) return null;
  // 계정 없이 보내면 엔진은 권한 필터 없이 답한다 — 모두의 문서가 보이는 쪽이다. 그래서 묻지도 않는다.
  if (!ACCOUNT_PATTERN.test(account)) return null;

  let payload: unknown;
  try {
    payload = await call(`/search/${encodeURIComponent(config.ragCollection)}`, {
      body: {
        searchMode: 0,
        searchField: ["BODY"],
        filterQuery: `<PARENT_ID:MATCH:${parentId}>`,
        documentField: ["DOCID", "PARENT_ID", "TITLE", "SOURCE", "ORD", "BODY"],
        // ORD 로 정렬하지 않는다: 정렬 가능 필드로 선언되었다는 보장이 없고, 아니면 400 이다.
        size: PARENT_CHUNK_LIMIT,
        authority: { field: AUTHORITY_FIELD, account },
      },
    });
  } catch (err) {
    // 엔진은 키가 하나도 없는 계정을 빈 결과가 아니라 400 으로 거절한다. 읽을 것이 없다는 뜻이다.
    if (err instanceof RagEngineError && err.status === 400) return null;
    throw err;
  }

  const rows = rowsOf(payload);
  const seen = new Set<string>();
  const chunks: EngineChunk[] = [];
  let title = "";
  for (const row of rows) {
    const fields = row?.fields ?? {};
    // MATCH 가 형태소 일치로 다른 문서까지 데려와도 여기서 거른다 — 같은 PARENT_ID 만.
    if (asText(fields.PARENT_ID) !== parentId) continue;
    const docId = asText(fields.DOCID);
    if (seen.has(docId)) continue;
    seen.add(docId);
    const ord = Number(asText(fields.ORD));
    if (!Number.isFinite(ord)) continue;
    title ||= asText(fields.TITLE) || asText(fields.SOURCE);
    chunks.push({ ord, text: asText(fields.BODY) });
  }
  if (chunks.length === 0) return null;
  const { text, ranges } = joinChunks(chunks);
  return { parentId, title, text, chunks: ranges, truncated: rows.length >= PARENT_CHUNK_LIMIT };
}
