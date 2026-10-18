/**
 * 대화 머리의 "출처 링크" 목록 — 답변이 기대 웹 페이지들.
 *
 * 출처는 두 갈래다.
 *   - 답변 본문에 링크로 적힌 주소(마크다운 링크·<주소>·맨 주소). 화면에서 누를 수
 *     있는 링크와 같은 것만 센다 — 코드 블록 안의 주소, 그림(![]()), 앱 안 링크(#cite-),
 *     http(s) 가 아닌 것(javascript: 등)은 빼고.
 *   - 그 턴에 웹 도구가 돌려준 주소. 검색(web_search 의 results[])·페이지 읽기
 *     (article_extract·wikipedia_lookup 의 url, http_fetch 는 결과에 주소가 없어 호출
 *     인자의 url)·MCP 도구 결과의 url. 문서 검색(rag_*)은 "출처 문서" 쪽이고, 크롬
 *     제어(browser_*)는 사용자 제 탭이라 출처로 치지 않는다.
 *
 * 같은 페이지는 한 줄이다: 해시와 끝의 "/" 를 떼고 비교한다. 한 답변 안에서는 본문이
 * 링크한 것 → 도구로 읽은 것 → 검색 결과에만 나온 것 순서로 놓는다 — 검색은 한 번에
 * 열 개씩 주소를 돌려주는데, 그중 답이 실제로 쓴 것은 본문 링크나 읽기로 드러난다.
 */

export interface SourceLink {
  /** 여는 주소 — 가장 최근에 나온 모양 그대로(해시 포함). */
  url: string;
  title: string;
  /** "www." 를 뗀 호스트. */
  hostname: string;
  /** 이 링크가 나온 답변 수. */
  count: number;
}

interface ToolCallLike {
  id: string;
  name: string;
  arguments: unknown;
}

interface ToolResultLike {
  id?: string;
  name: string;
  ok: boolean;
  result?: unknown;
}

interface MessageLike {
  role: string;
  content: string;
  toolCalls?: readonly ToolCallLike[];
  toolResults?: readonly ToolResultLike[];
}

/** 한 답변 안의 순위: 본문 링크가 먼저, 검색 결과에만 나온 것이 마지막. */
const Rank = { Linked: 0, Read: 1, Searched: 2 } as const;
type Rank = (typeof Rank)[keyof typeof Rank];

interface Mention {
  key: string;
  url: string;
  hostname: string;
  /** 페이지 제목(도구) 또는 링크 글자(본문). */
  title: string;
  fromTool: boolean;
  rank: Rank;
}

/** 내장 웹 도구. url_parse 처럼 주소를 다루기만 하는 도구는 출처가 아니다. */
const WEB_TOOL = /^(web_search|article_extract|http_fetch|wikipedia_lookup)$/;
const MCP_TOOL = /^mcp__/;
const RAG_TOOL = /(^|__)rag_(search|fetch)$/;

/** 비교 열쇠와 여는 주소. http(s) 절대 주소가 아니면 null. */
export function normalizeUrl(raw: string): { key: string; url: string; hostname: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return {
    key: `${parsed.protocol}//${parsed.host}${path}${parsed.search}`,
    url: parsed.href,
    hostname: parsed.hostname.replace(/^www\./, ""),
  };
}

/** MCP 결과는 JSON 을 담은 문자열로 온다. 내장 도구 결과는 객체다. */
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

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function mention(raw: unknown, title: unknown, fromTool: boolean, rank: Rank): Mention | null {
  if (typeof raw !== "string") return null;
  const normal = normalizeUrl(raw);
  return normal ? { ...normal, title: text(title), fromTool, rank } : null;
}

/**
 * 도구 결과 하나가 가리키는 페이지들. 맨 위의 url 은 "읽은 페이지", 맨 위 배열
 * (results 등) 안의 url 은 "검색 결과" 로 친다. 더 깊이는 내려가지 않는다 — MCP
 * 결과 깊숙한 곳의 url 은 대개 API 주소다.
 */
export function toolLinks(result: ToolResultLike, call?: ToolCallLike): Mention[] {
  if (!result.ok || RAG_TOOL.test(result.name)) return [];
  if (!WEB_TOOL.test(result.name) && !MCP_TOOL.test(result.name)) return [];
  const out: Mention[] = [];
  const payload = payloadOf(result.result);
  if (payload) {
    const top = mention(payload.url, payload.title, true, Rank.Read);
    if (top) out.push(top);
    for (const value of Object.values(payload)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const hit = mention((item as { url?: unknown }).url, (item as { title?: unknown }).title, true, Rank.Searched);
        if (hit) out.push(hit);
      }
    }
  }
  // http_fetch 는 본문만 돌려준다 — 무엇을 읽었는지는 호출 인자에 있다.
  if (out.length === 0 && call) {
    let args = call.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    const fetched = args && typeof args === "object" ? mention((args as { url?: unknown }).url, "", true, Rank.Read) : null;
    if (fetched) out.push(fetched);
  }
  return out;
}

/** 괄호 한 겹까지 품은 주소(위키백과의 "Foo_(bar)" 같은). */
const URL_BODY = String.raw`https?:\/\/[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*`;
const INLINE_LINK = new RegExp(String.raw`(!?)\[([^\]\n]*)\]\(\s*<?(${URL_BODY})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`, "g");
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/g;
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:\s*<?(https?:\/\/[^\s<>]+)>?/gm;
// 맨 주소는 GFM 처럼 공백·< 에서 끊는다. 호스트는 ASCII 로 묶어 "example.com에서" 의
// 조사가 호스트에 붙지 않게 하되, 경로의 한글("/w/대한민국")은 그대로 둔다.
const BARE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][^\s<>"'`]*)?/g;

/** GFM 의 끝자르기: 문장 부호와 짝 없는 닫는 괄호는 주소가 아니다. */
function trimBare(url: string): string {
  let out = url.replace(/[.,:;!?*_~'"]+$/, "");
  while (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,:;!?*_~'"]+$/, "");
  }
  return out;
}

/** 링크 글자가 주소 그대로이거나 비었으면 제목으로 쓰지 않는다. */
function linkTitle(label: string): string {
  const plain = label.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  return /^https?:\/\//i.test(plain) ? "" : plain;
}

/** 답변 본문에 링크로 보이는 주소들, 나온 순서대로. */
export function markdownLinks(content: string): Mention[] {
  // 코드는 링크가 아니다. 지운 자리는 공백으로 메워 앞뒤 낱말이 붙지 않게 한다.
  let rest = content.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const found: Array<{ at: number; m: Mention }> = [];
  const take = (pattern: RegExp, pick: (match: RegExpMatchArray) => Mention | null) => {
    rest = rest.replace(pattern, (...args) => {
      const match = args as unknown as RegExpMatchArray;
      const at = args[args.length - 2] as number;
      const m = pick(match);
      if (m) found.push({ at, m });
      return " ".repeat(match[0].length);
    });
  };
  take(INLINE_LINK, (m) => (m[1] ? null : mention(m[3], linkTitle(m[2] ?? ""), false, Rank.Linked)));
  take(AUTOLINK, (m) => mention(m[1], "", false, Rank.Linked));
  take(REFERENCE, (m) => mention(m[1], "", false, Rank.Linked));
  take(BARE, (m) => mention(trimBare(m[0]), "", false, Rank.Linked));
  return found.sort((a, b) => a.at - b.at).map((f) => f.m);
}

/** 한 답변이 가리키는 페이지들, 순위 → 나온 순서로. 같은 페이지는 처음 것에 제목만 보탠다. */
function answerLinks(message: MessageLike): Mention[] {
  const calls = new Map((message.toolCalls ?? []).map((c) => [c.id, c]));
  const all = [
    ...markdownLinks(message.content),
    ...(message.toolResults ?? []).flatMap((r) => toolLinks(r, r.id ? calls.get(r.id) : undefined)),
  ];
  const byKey = new Map<string, Mention>();
  for (const m of all) {
    const seen = byKey.get(m.key);
    if (!seen) {
      byKey.set(m.key, { ...m });
      continue;
    }
    // 검색으로 찾고 읽기까지 했으면 "읽은 것" 이다.
    if (m.rank < seen.rank) seen.rank = m.rank;
    if (m.fromTool && m.title && !seen.fromTool) {
      // 본문 링크의 글자보다 페이지 제목이 낫다.
      seen.title = m.title;
      seen.fromTool = true;
    } else if (!seen.title && m.title) seen.title = m.title;
  }
  return [...byKey.values()].sort((a, b) => a.rank - b.rank);
}

/** 답이 흐르는 동안 대화 머리가 토큰마다 다시 센다. 바뀌지 않은 메시지는 다시 풀지 않는다. */
const linksByMessage = new WeakMap<MessageLike, Mention[]>();

function cachedLinks(message: MessageLike): Mention[] {
  let links = linksByMessage.get(message);
  if (!links) {
    links = answerLinks(message);
    linksByMessage.set(message, links);
  }
  return links;
}

/** 대화의 출처 링크, 가장 최근 답변의 것부터. */
export function sourceLinks(messages: readonly MessageLike[]): SourceLink[] {
  const byKey = new Map<
    string,
    { link: SourceLink; toolTitle: string; linkTitle: string; lastAt: number; rank: Rank; order: number }
  >();
  messages.forEach((message, at) => {
    if (message.role !== "assistant") return;
    cachedLinks(message).forEach((m, order) => {
      const entry = byKey.get(m.key);
      if (!entry) {
        byKey.set(m.key, {
          link: { url: m.url, title: "", hostname: m.hostname, count: 1 },
          toolTitle: m.fromTool ? m.title : "",
          linkTitle: m.fromTool ? "" : m.title,
          lastAt: at,
          rank: m.rank,
          order,
        });
        return;
      }
      // 더 최근 답변에 다시 나왔다: 그 답변에서의 자리로 올리고, 주소도 그때 모양으로.
      entry.link.count++;
      entry.link.url = m.url;
      entry.lastAt = at;
      entry.rank = m.rank;
      entry.order = order;
      if (m.title) {
        if (m.fromTool) entry.toolTitle = m.title;
        else entry.linkTitle = m.title;
      }
    });
  });
  return [...byKey.values()]
    .sort((a, b) => b.lastAt - a.lastAt || a.rank - b.rank || a.order - b.order)
    .map(({ link, toolTitle, linkTitle: label }) => ({ ...link, title: toolTitle || label || bareTitle(link) }));
}

/** 제목을 모르면 호스트와 경로 — 아래 줄의 호스트만 되풀이하면 같은 사이트의 두 페이지를 가를 수 없다. */
function bareTitle(link: SourceLink): string {
  const path = new URL(link.url).pathname.replace(/\/+$/, "");
  try {
    return link.hostname + decodeURI(path);
  } catch {
    return link.hostname + path;
  }
}
