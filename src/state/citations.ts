/**
 * 답변 속 "[n]" 이 가리키는 문서 단락.
 *
 * 번호는 모델이 짓지 않는다. 한 턴에서 문서 검색 도구(rag_search·rag_fetch)가
 * 돌려준 단락을 **나온 순서대로** 1, 2, 3… 으로 매기고, 같은 단락(doc_id)이
 * 다시 나오면 처음 번호를 쓴다. 서버는 이 번호를 도구 결과에 `ref` 로 적어
 * 모델에게 보여 주고, 화면은 저장된 도구 결과로 같은 번호를 다시 계산한다.
 * 그래서 링크가 가리키는 곳은 늘 실제로 검색된 단락이다 — 모델이 주소를 지어낼
 * 틈이 없다.
 *
 * server/chat/citations.ts 와 규칙이 같아야 한다(server/chat/citations.test.ts 가
 * 둘을 대조한다). 브라우저와 Node 가 코드를 나눠 쓸 수 없어 두 벌이다.
 */
import { CITE } from "../components/citationMarkdown";

export interface CitationSource {
  n: number;
  /** 단락 id — `<문서id>#<순번>`. */
  chunkId: string;
  /** 문서 id — 문서 페이지의 id 와 같다. */
  documentId: string;
  ord: number;
  title: string;
  text: string;
}

interface ToolResultLike {
  name: string;
  ok: boolean;
  result?: unknown;
}

const RAG_TOOL = /(^|__)rag_(search|fetch)$/;

/** MCP 결과는 JSON 을 담은 문자열로 온다. 객체로 온 것도 받는다. */
function payloadOf(result: unknown): Record<string, unknown> | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** rag_search 는 `passages`, rag_fetch 는 `chunks` 에 단락을 담는다. */
export function passagesOf(result: unknown): Record<string, unknown>[] {
  const payload = payloadOf(result);
  if (!payload) return [];
  const list = Array.isArray(payload.passages) ? payload.passages : Array.isArray(payload.chunks) ? payload.chunks : [];
  return list.filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { doc_id?: unknown }).doc_id === "string");
}

export function isRagTool(name: string): boolean {
  return RAG_TOOL.test(name);
}

export function citationSources(toolResults: readonly ToolResultLike[] | undefined): CitationSource[] {
  const sources: CitationSource[] = [];
  const seen = new Map<string, number>();
  for (const tr of toolResults ?? []) {
    if (!tr.ok || !isRagTool(tr.name)) continue;
    for (const p of passagesOf(tr.result)) {
      const chunkId = String(p.doc_id);
      if (seen.has(chunkId)) continue;
      const n = sources.length + 1;
      seen.set(chunkId, n);
      const hash = chunkId.lastIndexOf("#");
      sources.push({
        n,
        chunkId,
        documentId: typeof p.parent_id === "string" && p.parent_id ? p.parent_id : hash > 0 ? chunkId.slice(0, hash) : chunkId,
        ord: Number(p.ord ?? (hash > 0 ? chunkId.slice(hash + 1) : 0)) || 0,
        title: typeof p.title === "string" ? p.title : "",
        text: typeof p.text === "string" ? p.text : "",
      });
    }
  }
  return sources;
}

/** 대화 머리의 "출처 문서" 목록 한 줄. */
export interface CitedDocument {
  documentId: string;
  title: string;
  /** 이 대화의 답변들이 이 문서에서 인용한 단락 수(같은 단락은 한 번). */
  count: number;
  /** 고르면 열 단락 — 이 문서를 인용한 가장 최근 답변에서 처음 나온 것. */
  source: CitationSource;
}

interface MessageLike {
  role: string;
  content: string;
  toolResults?: readonly ToolResultLike[];
}

/** 본문에 실제로 링크가 된 번호들, 나온 순서대로. 규칙은 citationMarkdown 과 같다 — 묶음의 번호가 하나라도 없으면 글자로 남는다. */
function linkedNumbers(content: string, valid: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const m of content.matchAll(CITE)) {
    const numbers = m[1]!.split(/[,，]/).map((s) => Number(s.trim()));
    if (numbers.every((n) => valid.has(n))) out.push(...numbers);
  }
  return out;
}

/** 답이 흐르는 동안 대화 머리가 토큰마다 다시 센다. 바뀌지 않은 메시지의 도구 결과는 다시 풀지 않는다. */
const sourcesByResults = new WeakMap<readonly ToolResultLike[], CitationSource[]>();

function cachedSources(toolResults: readonly ToolResultLike[] | undefined): CitationSource[] {
  if (!toolResults) return [];
  let sources = sourcesByResults.get(toolResults);
  if (!sources) {
    sources = citationSources(toolResults);
    sourcesByResults.set(toolResults, sources);
  }
  return sources;
}

/**
 * 대화가 인용한 문서들, 가장 최근에 인용한 것부터. 검색은 되었어도 답변 본문에 링크로
 * 나오지 않은 단락은 세지 않는다 — 화면에서 누를 수 있는 "[n]" 과 같은 것만 센다.
 */
export function citedDocuments(messages: readonly MessageLike[]): CitedDocument[] {
  const byDocument = new Map<string, { doc: CitedDocument; chunks: Set<string>; lastAt: number; order: number }>();
  messages.forEach((message, at) => {
    if (message.role !== "assistant") return;
    const sources = cachedSources(message.toolResults);
    if (sources.length === 0) return;
    const byNumber = new Map(sources.map((s) => [s.n, s]));
    const seenHere = new Set<string>();
    let order = 0;
    for (const n of linkedNumbers(message.content, new Set(byNumber.keys()))) {
      const source = byNumber.get(n)!;
      const entry = byDocument.get(source.documentId);
      if (!entry) {
        byDocument.set(source.documentId, {
          doc: { documentId: source.documentId, title: source.title, count: 0, source },
          chunks: new Set(),
          lastAt: at,
          order: order++,
        });
      } else if (!seenHere.has(source.documentId) && at > entry.lastAt) {
        // 더 최근 답변에서 다시 인용됐다: 그 답변의 첫 단락으로 열고 순서를 올린다.
        entry.doc.source = source;
        if (source.title) entry.doc.title = source.title;
        entry.lastAt = at;
        entry.order = order++;
      }
      seenHere.add(source.documentId);
      byDocument.get(source.documentId)!.chunks.add(source.chunkId);
    }
  });
  return [...byDocument.values()]
    .sort((a, b) => b.lastAt - a.lastAt || a.order - b.order)
    .map(({ doc, chunks }) => ({ ...doc, count: chunks.size }));
}
