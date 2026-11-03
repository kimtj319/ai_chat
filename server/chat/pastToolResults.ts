/**
 * What a PAST turn's tool results may take when the history is replayed.
 *
 * Replayed in full, one research turn's web pages and search results ran
 * 50-240k tokens (measured on production conversations, 2026-11-03), so a
 * single such turn filled the history-summary threshold by itself: the summary
 * then fired on turn after turn, each time folding just one exchange. Capping
 * each past turn's results keeps the answers verbatim and the conversation's
 * flow intact while the prompt stays small (simulated on 12 conversations:
 * mean prompt 41k -> 22k tokens, summaries 9 -> 0). The current turn's own tool
 * results never pass through here and are used whole.
 *
 * 16,000 characters is ~8k tokens at the 1.88 characters per token measured on
 * Korean text (chat/historySummary.ts). Below the cap nothing is touched, so a
 * turn that fits sends the same bytes every time and keeps the prefix cache.
 */
export const PAST_TURN_TOOL_RESULT_CHARS = 16_000;

/**
 * Strings up to this long are titles, URLs, ids and the like — never cut. A
 * 40-character floor cut every URL in a turn of 12 searches and every
 * reference the previous answer's "[n]" pointed at.
 */
const KEEP_WHOLE_CHARS = 300;

function note(original: number): string {
  return `[이전 턴의 도구 결과 — 다시 보내면서 길이를 줄였습니다(원래 ${original.toLocaleString()}자). 짧은 값(제목·주소·번호 등)은 그대로이고 긴 본문만 줄였으니, 세부 내용이 필요하면 도구를 다시 호출하세요.]`;
}

/** Shares of `budget` for items of these sizes: small items whole, the rest split evenly. */
function shares(sizes: number[], budget: number): number[] {
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  const out = new Array<number>(sizes.length);
  let left = budget;
  order.forEach(({ size, i }, k) => {
    const share = Math.min(size, Math.floor(left / (order.length - k)));
    out[i] = share;
    left -= share;
  });
  return out;
}

/** Every long string cut to `max` characters; structure and short values untouched. */
function clipStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.length > KEEP_WHOLE_CHARS && value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipStrings(v, max)]));
  }
  return value;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, longestString(v)), 0);
  if (value && typeof value === "object") return Object.values(value).reduce<number>((m, v) => Math.max(m, longestString(v)), 0);
  return 0;
}

/** The value inside a tool message's content, unwrapping a JSON string that holds JSON (MCP and RAG results). */
function parsed(content: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof value === "string") {
    try {
      const inner = JSON.parse(value);
      if (inner && typeof inner === "object") return inner;
    } catch {
      // plain text
    }
  }
  return value;
}

/**
 * One tool message's content cut toward `limit` characters by shortening its
 * long strings evenly. It stays valid JSON with every short value in place, so
 * when even that skeleton is over `limit` (dozens of calls in one turn) it is
 * sent over the limit rather than cut mid-structure.
 */
function shrink(content: string, limit: number): string {
  const head = note(content.length);
  // The newline after the note and a closing "…" are counted too.
  const room = Math.max(0, limit - head.length - 2);
  const value = parsed(content);
  if (typeof value === "string") return `${head}\n${value.slice(0, room)}…`;
  // The largest per-string length that still fits, so every passage and page keeps its share.
  let lo = 0;
  let hi = longestString(value);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(clipStrings(value, mid)).length <= room) lo = mid;
    else hi = mid - 1;
  }
  return `${head}\n${JSON.stringify(clipStrings(value, lo))}`;
}

/**
 * One past turn's tool message contents, fitted into `budget` characters in
 * total. Returned unchanged when they already fit.
 */
export function fitPastTurnToolResults(contents: string[], budget = PAST_TURN_TOOL_RESULT_CHARS): string[] {
  const total = contents.reduce((s, c) => s + c.length, 0);
  if (total <= budget) return contents;
  const limits = shares(
    contents.map((c) => c.length),
    budget,
  );
  return contents.map((c, i) => (c.length <= limits[i]! ? c : shrink(c, limits[i]!)));
}
