import { assertPublicHostname } from "./ssrf.js";
import { config } from "../../config.js";

/**
 * The one guarded GET every tool that reaches the public web goes through.
 *
 * http_fetch and article_extract each carried their own copy of this — the URL
 * check, the manual redirect loop, the streaming cap, the constants — byte for
 * byte identical. Two copies of a security check is not a tidiness problem: the
 * next time one is tightened, the other keeps the hole, and nothing in the
 * types or the tests would say so.
 */

/**
 * 모델에게 갈 말. 무엇을 하지 말라가 아니라 **대신 무엇을 쓰라** 를 말해야
 * 다음 한 수가 달라진다. 도구 이름을 그대로 적는 이유도 그것이다.
 */
export const GITLAB_REDIRECT =
  "이 주소는 여기서 읽을 수 없습니다(인증서 체인 미검증). GitLab 이슈는 " +
  "mcp__gitlab__gitlab_issues(목록·검색), mcp__gitlab__gitlab_issue(본문), " +
  "mcp__gitlab__gitlab_issue_notes(댓글), mcp__gitlab__gitlab_labels(라벨) 로 조회하세요. " +
  "이 도구들로 얻을 수 없는 것(예: 사용자 프로필)은 GitLab 에서 직접 확인해야 한다고 answer 하세요.";

/** Hard cap while streaming. The runner truncates to its own limit afterwards. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** What the builtin web tools identify as. */
export const TOOL_USER_AGENT = "qwen3-web-chat-tool/1.0";

/** `[::1]` → `::1`: URL keeps the brackets on an IPv6 hostname, DNS and isIP want them off. */
export function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Refuse anything but http(s), and anything pointing inside the network this
 * server sits on — unless the operator named the host in TOOL_FETCH_ALLOWLIST,
 * which is an explicit decision to trust it.
 */
export async function assertFetchableUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }
  const hostname = stripBrackets(url.hostname).toLowerCase();
  // 이 호스트는 여기서 읽히지 않는다 — 그리고 그건 고칠 수 있는 상태가 아니라
  // 이 컨테이너의 사실이다(GitLab 이 중간 인증서를 보내지 않고, Node 는 그걸
  // 따로 받아 오지 않는다). 그대로 두면 매번 10초를 버린 뒤 모델에게 "fetch
  // failed" 만 남기므로, 시도하기 전에 거절하고 **대신 쓸 것**을 알려 준다.
  // 허용목록보다 먼저 보는 이유는, 허용해 두었다고 해서 닿게 되지는 않기 때문이다.
  if (config.gitlabHost && hostname === config.gitlabHost) {
    throw new Error(GITLAB_REDIRECT);
  }
  if (config.toolFetchAllowlist.length > 0) {
    if (!config.toolFetchAllowlist.includes(hostname)) {
      throw new Error(`Host not in TOOL_FETCH_ALLOWLIST: ${hostname}`);
    }
    return; // explicitly allowlisted by the operator — trust it, skip the private-range check
  }
  await assertPublicHostname(hostname);
}

/** Read a response body with a hard byte cap, cancelling the stream past it. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

export interface FollowOptions {
  maxRedirects: number;
  /** Runs before every hop, the first one included. Throws to refuse it. */
  assertHop: (url: URL) => Promise<void>;
  /**
   * Refuse a redirect that leaves the starting origin. A hop re-sends the same
   * headers, credentials included, and fetch's own handling — which strips them
   * on an origin change — is exactly what `redirect: "manual"` turns off.
   */
  sameOrigin?: boolean;
  messages: {
    noLocation: (status: number) => string;
    tooMany: string;
    crossOrigin?: (from: URL, to: URL) => string;
  };
}

/**
 * Redirects followed by hand, so every hop is checked: `redirect: "follow"`
 * would let a public URL bounce the request onto a private address with nothing
 * looking at the second one. The body of each 3xx is cancelled so its socket is
 * released now rather than at GC.
 */
export async function followGuarded(startUrl: string | URL, init: RequestInit, options: FollowOptions): Promise<Response> {
  const start = new URL(startUrl);
  let current = start;
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    await options.assertHop(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error(options.messages.noLocation(res.status));
      const next = new URL(location, current);
      if (options.sameOrigin && next.origin !== start.origin) {
        throw new Error(options.messages.crossOrigin?.(start, next) ?? `Cross-origin redirect refused: ${next.origin}`);
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error(options.messages.tooMany);
}

export interface GuardedResponse {
  status: number;
  contentType: string;
  text: string;
}

/**
 * One timeout for the whole call — every hop and the body read — rather than a
 * fresh one per hop, which let six hops run for six times the budget after the
 * runner had already told the model the call timed out.
 */
export async function guardedFetchText(startUrl: string): Promise<GuardedResponse> {
  const res = await followGuarded(
    startUrl,
    {
      method: "GET",
      signal: AbortSignal.timeout(config.toolHttpTimeoutMs),
      headers: { "User-Agent": TOOL_USER_AGENT },
    },
    {
      maxRedirects: MAX_REDIRECTS,
      assertHop: assertFetchableUrl,
      messages: {
        noLocation: (status) => `Redirect with no Location header (status ${status})`,
        tooMany: `Too many redirects (> ${MAX_REDIRECTS})`,
      },
    },
  );
  return { status: res.status, contentType: res.headers.get("content-type") || "", text: await readBodyCapped(res, MAX_DOWNLOAD_BYTES) };
}
