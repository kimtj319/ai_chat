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
