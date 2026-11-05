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

/** What was done to a result, said in its note: each step drops something different. */
type Cut = "strings" | "items" | "sliced";

function note(original: number, cut: Cut = "strings"): string {
  const size = `원래 ${original.toLocaleString()}자`;
  if (cut === "items") {
    return `[이전 턴의 도구 결과 — 다시 보내면서 줄였습니다(${size}). 목록은 앞쪽 일부와 답변이 인용한 항목만 남기고 긴 본문은 지웠으니, 나머지가 필요하면 도구를 다시 호출하세요.]`;
  }
  if (cut === "sliced") {
    return `[이전 턴의 도구 결과 — 다시 보내면서 앞부분만 남겼습니다(${size}, 중간에 끊겨 형식이 온전하지 않음). 필요하면 도구를 다시 호출하세요.]`;
  }
  return `[이전 턴의 도구 결과 — 다시 보내면서 길이를 줄였습니다(${size}). 짧은 값(제목·주소·번호 등)은 그대로이고 긴 본문만 줄였으니, 세부 내용이 필요하면 도구를 다시 호출하세요.]`;
}

/** A cited passage keeps this much of its text even when the rest of the list is cut to the bone. */
const CITED_TEXT_CHARS = 600;

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
 * Every array longer than `items` keeps its first `items` entries and says how
 * many it dropped; long strings are clipped as in clipStrings. Whole entries
 * stay intact, so a kept search hit or page keeps its title, URL and id.
 */
function clipArrays(value: unknown, items: number, maxString: number, cited: ReadonlySet<number>, citedText = CITED_TEXT_CHARS): unknown {
  if (typeof value === "string") return clipStrings(value, maxString);
  if (Array.isArray(value)) {
    // The first `items` entries, plus every entry the answer cited by its ref.
    const kept = value
      .filter((v, i) => i < items || isCited(v, cited))
      .map((v) => clipArrays(v, items, isCited(v, cited) ? Math.max(maxString, citedText) : maxString, cited, citedText));
    return value.length > kept.length ? [...kept, `…외 ${value.length - kept.length}개 항목 생략`] : kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipArrays(v, items, maxString, cited, citedText)]));
  }
  return value;
}

/** An entry carrying a citation number the answer used ("[n]" in its text). */
function isCited(value: unknown, cited: ReadonlySet<number>): boolean {
  const ref = (value as { ref?: unknown } | null)?.ref;
  return typeof ref === "number" && cited.has(ref);
}

/** The citation numbers an answer used, so the passages they point at survive any cut. */
export function citedRefs(answer: string): Set<number> {
  return new Set([...answer.matchAll(/\[(\d{1,4})\]/g)].map((m) => Number(m[1])));
}

function longestArray(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, longestArray(v)), value.length);
  if (value && typeof value === "object") return Object.values(value).reduce<number>((m, v) => Math.max(m, longestArray(v)), 0);
  return 0;
}

/** Below this a result's share has no room for any of its content: one line saying it was there. */
const MIN_CONTENT_CHARS = 160;

/**
 * One tool message's content cut toward `limit` characters, in three steps,
 * each tried only when the one before cannot fit:
 *
 * 1. Long strings shortened evenly; every short value (title, URL, id) kept.
 * 2. Arrays cut to their first entries (whole entries, "…외 N개 항목 생략"),
 *    keeping every entry whose ref the answer cited so its "[n]" still resolves.
 *    Step 1 alone could not shrink a result made of many SHORT values — a
 *    Confluence page list, a JSON search result — so a 46-call research turn
 *    replayed 225k characters against a 16k cap (production, 2026-11-05).
 * 3. The JSON text itself sliced — no longer valid JSON, but bounded.
 */
function shrink(content: string, limit: number, cited: ReadonlySet<number>): string {
  if (limit < MIN_CONTENT_CHARS) return shortNote(content.length);
  // The room left once the step's own note (and its newline and closing "…") is in.
  const roomFor = (cut: Cut) => Math.max(0, limit - note(content.length, cut).length - 2);
  const value = parsed(content);
  if (typeof value === "string") return `${note(content.length)}\n${value.slice(0, roomFor("strings"))}…`;
  const fits = (v: unknown, cut: Cut) => JSON.stringify(v).length <= roomFor(cut);
  // Step 1: the largest per-string length that still fits, so every passage keeps its share.
  let lo = 0;
  let hi = longestString(value);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(clipStrings(value, mid), "strings")) lo = mid;
    else hi = mid - 1;
  }
  const clipped = clipStrings(value, lo);
  if (fits(clipped, "strings")) return `${note(content.length)}\n${JSON.stringify(clipped)}`;
  // Step 2: as many leading entries per array as fit, long strings at the floor.
  // Cited passages keep some text when that fits; if not, only their ref and
  // title, which is still valid JSON — better than the slice below.
  let trimmed: unknown = value;
  for (const citedText of [CITED_TEXT_CHARS, 0]) {
    let few = 0;
    let many = longestArray(value);
    while (few < many) {
      const mid = Math.ceil((few + many) / 2);
      if (fits(clipArrays(value, mid, 0, cited, citedText), "items")) few = mid;
      else many = mid - 1;
    }
    trimmed = clipArrays(value, few, 0, cited, citedText);
    if (fits(trimmed, "items")) return `${note(content.length, "items")}\n${JSON.stringify(trimmed)}`;
  }
  // Step 3: nothing structural fits; a bounded slice of the text, and the note says so.
  return `${note(content.length, "sliced")}\n${JSON.stringify(trimmed).slice(0, roomFor("sliced"))}…`;
}

function shortNote(original: number): string {
  return `[이전 턴 도구 결과 생략(원래 ${original.toLocaleString()}자) — 필요하면 도구를 다시 호출하세요.]`;
}

/**
 * One past turn's tool message contents, fitted into `budget` characters in
 * total. Returned unchanged when they already fit.
 */
export function fitPastTurnToolResults(
  contents: string[],
  budget = PAST_TURN_TOOL_RESULT_CHARS,
  cited: ReadonlySet<number> = new Set(),
): string[] {
  const total = contents.reduce((s, c) => s + c.length, 0);
  if (total <= budget) return contents;
  const limits = shares(
    contents.map((c) => c.length),
    budget,
  );
  return contents.map((c, i) => (c.length <= limits[i]! ? c : shrink(c, limits[i]!, cited)));
}
