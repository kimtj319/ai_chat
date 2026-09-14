import fs from "node:fs";
import path from "node:path";

// Minimal hand-rolled .env loader (no `dotenv` dependency). Only used as a
// convenience for `npm run dev:server`; real process env vars always win,
// and start_web.sh does its own `.env` sourcing before spawning the server.
function loadDotEnvFile(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile(path.resolve(process.cwd(), ".env"));

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A 0..1 fraction. Unparsable or out-of-range values fall back instead of disabling the guard. */
function toRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/**
 * Milliseconds, with a floor. A timeout of zero — or a typo that parses as one
 * — aborts every request before it can answer, which reads as "the service is
 * down" rather than as a misconfiguration, so anything unparsable or under a
 * second falls back to the default instead.
 */
function toDurationMs(value: string | undefined, fallback: number, minimumMs = 1000): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimumMs ? parsed : fallback;
}

const cwd = process.cwd();

export interface VllmEndpoint {
  /** Human-readable name shown in the UI when several endpoints serve models. */
  label: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Parse endpoint definitions: `label|baseUrl` entries, with an optional third
 * `|apiKey` field overriding VLLM_API_KEY for that one endpoint, and a bare URL
 * with no label accepted as well. Blank entries and `#` comments are skipped.
 *
 * One parser, two sources: VLLM_ENDPOINTS splits on commas and the .model file
 * splits on newlines (vllm/endpoints.ts). They must not become two dialects —
 * an operator who learns one has learned the other.
 */
export function parseEndpointEntries(entries: Iterable<string>, fallbackKey: string): VllmEndpoint[] {
  const endpoints: VllmEndpoint[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|").map((s) => s.trim());
    const hasLabel = parts.length > 1;
    const label = hasLabel ? parts[0]! : "";
    const baseUrl = (hasLabel ? parts[1]! : parts[0]!).replace(/\/+$/, "");
    if (!baseUrl) continue;
    endpoints.push({
      label: label || baseUrl,
      baseUrl,
      apiKey: (hasLabel && parts[2]) || fallbackKey,
    });
  }
  return endpoints;
}

/** Exactly what VLLM_ENDPOINTS declares — empty when it is unset. */
const vllmEnvEndpoints = parseEndpointEntries((process.env.VLLM_ENDPOINTS || "").split(","), process.env.VLLM_API_KEY || "");

/**
 * The env endpoints, or the single VLLM_BASE_URL fallback when nothing is
 * configured, so an existing single-endpoint deployment keeps working. The file
 * endpoints are merged on top of this at call time (vllm/endpoints.ts).
 */
function parseEndpoints(): VllmEndpoint[] {
  if (vllmEnvEndpoints.length > 0) return vllmEnvEndpoints;
  const baseUrl = (process.env.VLLM_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, "");
  return [{ label: baseUrl, baseUrl, apiKey: process.env.VLLM_API_KEY || "" }];
}

const vllmEndpoints = parseEndpoints();
const contextToolStopRatio = toRatio(process.env.CONTEXT_TOOL_STOP_RATIO, 0.8);

/**
 * CONTEXT_COMPACT_RATIO, kept strictly below CONTEXT_TOOL_STOP_RATIO. 0 means
 * "no compaction", so this cannot use toRatio() (which treats 0 as unparsable
 * and falls back). Compaction is only useful while tools are still offered —
 * past the stop ratio they are already gone and there is nothing left to
 * research — so a value at or above the stop ratio would mean compaction never
 * fires. Clamp it rather than silently doing nothing, and say so once.
 */
function resolveCompactRatio(raw: string | undefined, fallback: number, stopRatio: number): number {
  const trimmed = (raw ?? "").trim();
  let ratio = fallback;
  if (trimmed) {
    const parsed = Number.parseFloat(trimmed);
    ratio = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
  }
  if (ratio === 0 || ratio < stopRatio) return ratio;
  const clamped = stopRatio * 0.875; // 0.8 -> 0.7, the documented default
  console.warn(
    `[config] CONTEXT_COMPACT_RATIO=${ratio} must be below CONTEXT_TOOL_STOP_RATIO=${stopRatio}; ` +
      `compaction would never run, so using ${clamped.toFixed(3)}.`,
  );
  return clamped;
}

export const config = {
  port: toInt(process.env.PORT, 8080),
  vllmEndpoints,
  /** Only what the environment declared; empty means "nothing configured". */
  vllmEnvEndpoints,
  /** First endpoint's URL. Kept for logging and single-endpoint call sites. */
  vllmBaseUrl: vllmEndpoints[0]!.baseUrl,
  /**
   * Optional file of extra serving endpoints, merged with VLLM_ENDPOINTS at
   * request time so a newly served model appears without an env change or a
   * rebuild. Empty means "use the default lookup order" (vllm/endpoints.ts).
   */
  modelEndpointsFile: (process.env.MODEL_ENDPOINTS_FILE || "").trim(),
  /**
   * Shared secret for POST/DELETE /api/models/endpoints, sent as
   * X-Model-Admin-Token. Unset means anyone who can reach the app can make it
   * fetch an arbitrary address and can register an endpoint that receives other
   * people's conversations — the app has no authentication of its own. Unset is
   * only reasonable on a trusted network; the mutations are logged with the
   * client IP either way, and GET reports `unprotected: true`.
   */
  modelAdminToken: (process.env.MODEL_ADMIN_TOKEN || "").trim(),
  /**
   * 모델별 추론 설정. "패턴=fixed" 또는 "패턴=budget[:최소값]" 을 쉼표로 잇는다.
   * 어떤 모델이 추론 필드를 받아들이는지는 서빙하는 쪽 사정이라 코드가 아니라
   * 배포가 안다 — 해석과 근거는 chat/reasoningProfiles.ts 에 있다.
   */
  reasoningProfiles: (process.env.REASONING_PROFILES || "").trim(),
  dataDir: path.resolve(cwd, process.env.DATA_DIR || "./data"),
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  /**
   * Where web_search sends its query. Only worth changing for a Tavily-
   * compatible proxy or a mirror inside a network that cannot reach
   * api.tavily.com; the request shape and the bearer-token header are Tavily's.
   */
  tavilyApiUrl: (process.env.TAVILY_API_URL || "https://api.tavily.com/search").replace(/\/+$/, ""),
  toolFetchAllowlist: (process.env.TOOL_FETCH_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  toolFsRoot: path.resolve(cwd, process.env.TOOL_FS_ROOT || "."),
  /**
   * Hard cap on ONE tool call, enforced by the runner around every tool
   * (tools/runner.ts). A tool that is still working when it expires is
   * reported as a timeout to the model, which then answers without it. Raise it
   * for an allowlisted internal service that is slow to answer; the whole turn
   * waits on this, so a generous value is paid in latency on every failure.
   */
  toolTimeoutMs: toDurationMs(process.env.TOOL_TIMEOUT_MS, 10_000),
  /**
   * Timeout for one outbound HTTP request made by a tool (web_search,
   * http_fetch, article_extract, currency_convert; the two-leg weather and
   * wikipedia tools give each leg a share of it). Kept separate from
   * TOOL_TIMEOUT_MS so the runner's cap stays the outer bound: raising this
   * above the runner's cap buys nothing, because the runner aborts first.
   */
  toolHttpTimeoutMs: toDurationMs(process.env.TOOL_HTTP_TIMEOUT_MS, 10_000),
  /**
   * How much of a tool result reaches the model; the rest is truncated with a
   * marker (tools/runner.ts). This is the number the context comments below are
   * written against — one 100KB http_fetch result is roughly 25k tokens — so
   * raising it makes each research round cost proportionally more of the
   * window and makes compaction fire sooner.
   */
  toolMaxResultBytes: toInt(process.env.TOOL_MAX_RESULT_BYTES, 100 * 1024),
  /**
   * Escape hatch only: hard cap on tool-calling rounds in one turn.
   * 0 (default) = unlimited — the context budget terminates the loop instead
   * (chat/contextBudget.ts), which is a real limit rather than a guessed one.
   */
  toolMaxRounds: toInt(process.env.TOOL_MAX_ROUNDS, 0),
  /**
   * Once the prompt already fills this fraction of the model's context window,
   * stop offering tools for the rest of the turn and let the model answer.
   * A further tool round would add another result and push the request past
   * the window, which the server rejects with a 400 and the turn is lost.
   */
  contextToolStopRatio,
  /**
   * Once the prompt fills this fraction of the context window while tools are
   * still being offered, summarise the turn's research into one interim report
   * and rebuild the context around it (chat/contextCompaction.ts) instead of
   * letting the ladder shrink tool results to 600-char excerpts. 0 disables it.
   * 0.7 is chosen so the summarisation call itself fits: 0.7 x 262144 ~= 183.5k
   * input tokens plus an 8192-token report is comfortably inside the window.
   */
  contextCompactRatio: resolveCompactRatio(process.env.CONTEXT_COMPACT_RATIO, 0.7, contextToolStopRatio),
  /**
   * How much of the window compaction leaves un-summarised: the most recent
   * tool exchanges stay verbatim while they fit under this fraction, and only
   * the older ones become the interim report. The newest results are the ones
   * the model is still reasoning about, and prose loses the detail exactly
   * there. 0.15 x 262144 ~= 39k tokens — room for the last one or two 100KB
   * http_fetch results (~25k tokens each) — while the summarised part still
   * frees the bulk of the 183.5k that triggered compaction. Keep it well below
   * contextCompactRatio: at or above it nothing is ever old enough to
   * summarise, so compaction reports that it has nothing to gain and the turn
   * falls back to the budget ladder.
   */
  contextKeepRecentRatio: toRatio(process.env.CONTEXT_KEEP_RECENT_RATIO, 0.15),
  /**
   * How many times one turn may compact. Each compaction costs an extra model
   * call, and this is also what makes the uncapped tool loop terminate: once it
   * is spent the prompt grows monotonically again, crosses
   * contextToolStopRatio, and tools are dropped (see chat/toolLoop.ts).
   */
  contextMaxCompactions: toInt(process.env.CONTEXT_MAX_COMPACTIONS, 2),
  /**
   * "Normal" reasoning mode's ceiling on how long the model may think before
   * the turn is stopped and asked to write its answer from the reasoning it
   * already produced (chat/reasoningDeadline.ts). "External" mode ignores it
   * and waits. Three minutes by default: measured here, the same question
   * finished in 35s on one run and was still thinking after twenty minutes on
   * another, so the ceiling is what turns the second case into an answer
   * instead of an empty turn.
   */
  normalModeDeadlineMs: toDurationMs(process.env.NORMAL_MODE_DEADLINE_MS, 3 * 60 * 1000),
  /**
   * Attachment limits. All of them are refusals at upload or send time, so the
   * prompt can never be assembled out of something the window cannot hold.
   *
   * These are the transport limits — upload time, disk, base64 latency. The
   * token limits are derived from the model's own window instead
   * (attachments/budget.ts); the two are separate on purpose, because the
   * server rescales any image to at most 16,386 tokens however many bytes it
   * arrived as.
   */
  attachmentMaxImageBytes: toInt(process.env.ATTACHMENT_MAX_IMAGE_BYTES, 10 * 1024 * 1024),
  attachmentMaxTextBytes: toInt(process.env.ATTACHMENT_MAX_TEXT_BYTES, 2 * 1024 * 1024),
  /**
   * Text at or below this size goes into the prompt verbatim; above it the
   * prompt gets a stub and the model reads the rest with read_attachment.
   * 32KB is ~8-11k tokens of prose — affordable next to a question, where a
   * 2MB file would be most of the window.
   */
  attachmentInlineTextBytes: toInt(process.env.ATTACHMENT_INLINE_TEXT_BYTES, 32 * 1024),
  attachmentMaxPerMessage: toInt(process.env.ATTACHMENT_MAX_PER_MESSAGE, 6),
  attachmentMaxMessageBytes: toInt(process.env.ATTACHMENT_MAX_MESSAGE_BYTES, 25 * 1024 * 1024),
  /**
   * Fraction of the CONVERSATION'S OWN model window that all attachments of one
   * message may cost. 0.25 x 262144 = 65,536 tokens on this model — computed
   * from what the model reports, so a conversation on a smaller model gets a
   * smaller ceiling instead of one written down here.
   */
  attachmentMessageTokenRatio: toRatio(process.env.ATTACHMENT_MESSAGE_TOKEN_RATIO, 0.25),
  /** Used only when a model reports no window at all; the refusal says so. */
  attachmentDefaultMessageTokens: toInt(process.env.ATTACHMENT_DEFAULT_MESSAGE_TOKENS, 65536),
  attachmentMaxPerConversation: toInt(process.env.ATTACHMENT_MAX_PER_CONVERSATION, 20),
  attachmentMaxConversationBytes: toInt(process.env.ATTACHMENT_MAX_CONVERSATION_BYTES, 100 * 1024 * 1024),
  attachmentMaxSessionBytes: toInt(process.env.ATTACHMENT_MAX_SESSION_BYTES, 500 * 1024 * 1024),
  /** Uploads per minute per session, refilled continuously (429 when spent). */
  attachmentUploadsPerMinute: toInt(process.env.ATTACHMENT_UPLOADS_PER_MINUTE, 30),
  /**
   * Refuse uploads (507) below this much free space on DATA_DIR. A full disk
   * corrupts conversations, not just the upload that filled it.
   */
  attachmentMinFreeDiskBytes: toInt(process.env.ATTACHMENT_MIN_FREE_DISK_BYTES, 1024 * 1024 * 1024),
  /**
   * Send one tiny probe request per newly seen model when the catalog is built,
   * to find out what it can actually do, and hide the ones that can do nothing
   * (vllm/capability.ts). Set MODEL_CAPABILITY_PROBE=0 to skip it: the catalog
   * is then whatever /v1/models listed, including models that fail the moment
   * anyone picks them.
   */
  modelCapabilityProbe: !/^(0|false|no|off)$/i.test((process.env.MODEL_CAPABILITY_PROBE || "").trim()),
  /**
   * Hostnames an MCP server may live on. Empty (the default) means "any public
   * host", the same rule TOOL_FETCH_ALLOWLIST states for http_fetch — except
   * that here the public-host check is NOT the whole guard: this deployment's
   * model servers are themselves on PUBLIC addresses (a routable address, not loopback) and
   * the container uses host networking, so mcp/client.ts additionally refuses
   * any host that matches a configured vLLM endpoint, allowlist or not.
   */
  mcpAllowedHosts: (process.env.MCP_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /**
   * How long a discovered tool list and health verdict stay usable before the
   * next use kicks off a background refresh (mcp/discovery.ts). The tool list
   * is a fixed cost in every prompt of every turn, so this is not a cache that
   * may be skipped: a turn NEVER goes to the network for it.
   */
  /**
   * Hosts an MCP server may be reached on over plain http.
   *
   * This relaxes ONE rule — transport encryption — and nothing else. The
   * private-address refusal in mcp/client.ts still runs for these hosts, so a
   * name here cannot turn the app into a route into anything it could not
   * already reach; and the model-server refusal still runs, so it cannot be
   * pointed at a vLLM endpoint either. What it allows is exactly the case it is
   * named for: a service the operator runs on the same internal network, on a
   * public address, with no certificate.
   *
   * Empty by default. A host only appears here because someone wrote it into
   * .env, which is the same place the model endpoints and the search keys live.
   */
  mcpAllowHttpHosts: (process.env.MCP_ALLOW_HTTP_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
  mcpDiscoveryTtlMs: toDurationMs(process.env.MCP_DISCOVERY_TTL_MS, 10 * 60 * 1000),
  /**
   * Default per-call timeout written onto a new MCP server record (clamped to
   * 1000..9000 there). Deliberately under TOOL_TIMEOUT_MS (10s) so the runner's
   * cap stays the outer bound — and unlike the runner's timeout, this one
   * actually CANCELS the request: runner.ts's withTimeout rejects without
   * aborting the work it was waiting on.
   */
  mcpTimeoutMs: toDurationMs(process.env.MCP_TIMEOUT_MS, 8000),
  /**
   * Log sha256(JSON.stringify(tools)) once per tool-calling round. The hash has
   * to be identical on every round of a turn — see chat/toolLoop.ts on the
   * 33s-versus-2.3s prefill recompute — and this is how that gets checked on a
   * running deployment instead of assumed.
   */
  mcpDebugToolsHash: /^(1|true|yes|on)$/i.test((process.env.MCP_DEBUG_TOOLS_HASH || "").trim()),
  /**
   * Key for the Alpha Vantage builtin MCP server. That server takes it as a
   * query parameter and accepts no auth header, so it ends up inside the
   * record's URL — which is why routes/mcp.ts strips the query before the URL
   * reaches a client. Empty means the builtin is not seeded at all
   * (mcp/registryStore.ts).
   */
  alphavantageApiKey: (process.env.ALPHAVANTAGE_API_KEY || "").trim(),
  /**
   * The SF-1 RAG MCP server's endpoint. Empty means the builtin is not seeded,
   * for the same reason as the Alpha Vantage key above: a server nobody can
   * reach is a broken-looking entry in everyone's library.
   */
  ragMcpUrl: (process.env.RAG_MCP_URL || "").trim(),
  /**
   * The GitLab issue MCP server's endpoint, and the token it is to use.
   *
   * The token lives HERE and not on that server. It is appended to the URL as
   * `?token=…` when the builtin is seeded, and the MCP server forwards it to
   * GitLab without storing it — so the one secret does two jobs: it is the
   * credential GitLab checks, and it is what makes the MCP port useless to
   * anyone who reaches it without it. routes/mcp.ts strips the query before
   * the URL is shown to any account, as it already does for Alpha Vantage.
   *
   * Either one empty means the builtin is not seeded at all.
   */
  gitlabMcpUrl: (process.env.GITLAB_MCP_URL || "").trim(),
  gitlabToken: (process.env.GITLAB_TOKEN || "").trim(),
  /**
   * The GitLab that the MCP server above covers, as a bare hostname.
   *
   * The app never calls GitLab itself. It needs the name for one reason: this
   * container cannot complete GitLab's TLS chain (the server sends no
   * intermediate certificate, and unlike macOS, Node does not fetch one), so
   * http_fetch and article_extract spend ten seconds timing out and then tell
   * the model nothing useful. tools/net/guardedFetch.ts refuses the host up
   * front instead, and names the MCP tools that do work.
   *
   * Empty (the default) means no such rule — nothing is refused.
   */
  gitlabHost: (() => {
    const raw = (process.env.GITLAB_URL || "").trim();
    if (!raw) return "";
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      // A bare hostname is a reasonable thing for someone to write here.
      return raw.replace(/^https?:\/\//i, "").split("/")[0]!.toLowerCase();
    }
  })(),
  /**
   * The secret that lets this application say WHO is asking, on the MCP servers
   * that take our word for it (McpServerRecord.sendUserIdentity).
   *
   * It is not a user's credential and does not live in anyone's owner file: it
   * authenticates the APPLICATION to a first-party server, and the identity it
   * vouches for is the signed-in owner. The receiving server ignores the
   * identity header unless this matches, so the account it filters documents by
   * cannot be set by anything that merely reaches the port.
   *
   * Empty means no identity is sent at all and such a server sees every request
   * as its own default account — fewer documents, never more.
   */
  mcpIdentityToken: (process.env.MCP_IDENTITY_TOKEN || "").trim(),
  /**
   * The search engine this app indexes uploaded documents into. Empty (the
   * default) turns the 문서 page off entirely rather than showing a page whose
   * every action fails — reading is the MCP server's job and works without it.
   */
  ragEngineUrl: (process.env.RAG_ENGINE_URL || "").trim().replace(/\/+$/, ""),
  /** The collection uploaded documents go into. Must already exist — see rag/engineIndex.ts. */
  ragCollection: (process.env.RAG_COLLECTION || "rag").trim(),
  /**
   * Largest document accepted for indexing.
   *
   * The engine embeds every chunk AT INDEX TIME — measured at about 34ms per
   * chunk — so the ceiling here is really a ceiling on how long one upload
   * request may hold the connection. 512KB is roughly 290 chunks, about ten
   * seconds, and around 180,000 Korean characters: a long document, not a
   * corpus. Raising it without adding progress reporting makes uploads look
   * hung rather than slow.
   */
  ragDocMaxBytes: toInt(process.env.RAG_DOC_MAX_BYTES, 512 * 1024),
  /**
   * The model that picks chunk boundaries, and where it lives (an OpenAI-shaped
   * /chat/completions endpoint, WITHOUT the trailing path — e.g.
   * http://host:30100/v1).
   *
   * It is asked for LINE NUMBERS and never for text. Measured: asking the same
   * model to emit the chunk bodies returned 98.4% of an 828-character document
   * and silently dropped its heading, while asking for boundaries took 0.2s and
   * eight output tokens with the text untouched, because we do the cutting.
   *
   * Empty means chunking stays purely rule-based — which is a slightly worse
   * set of boundaries, never a broken upload.
   */
  ragChunkModelUrl: (process.env.RAG_CHUNK_MODEL_URL || "").trim().replace(/\/+$/, ""),
  ragChunkModel: (process.env.RAG_CHUNK_MODEL || "").trim(),
  ragChunkToken: (process.env.RAG_CHUNK_TOKEN || "").trim(),
  /**
   * Largest PDF accepted. Separate from RAG_DOC_MAX_BYTES because a PDF is
   * mostly fonts and images — a 9MB manual carries a few hundred KB of text —
   * so the file size says almost nothing about the indexing cost. What is
   * capped by RAG_DOC_MAX_BYTES is the TEXT that comes out.
   */
  ragPdfMaxBytes: toInt(process.env.RAG_PDF_MAX_BYTES, 20 * 1024 * 1024),
  /** 날짜별 로그 파일이 놓이는 곳. 비우면 파일 기록 없이 stdout 만 쓴다. */
  logDir: (process.env.LOG_DIR || "log").trim(),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "sid",
  /**
   * Add `Secure` to the session cookie. Leave false for plain-HTTP
   * deployments (a Secure cookie is simply dropped by the browser there);
   * set COOKIE_SECURE=1 once the app is served over HTTPS.
   */
  cookieSecure: /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE || ""),
  /**
   * How long a sign-in lasts, in hours, counted from the moment it happened
   * and never extended by activity. A stolen cookie is a valid sign-in until
   * it expires, so on a port reachable from outside this wants to be days, not
   * the month a cookie Max-Age alone used to allow.
   */
  sessionMaxAgeHours: toInt(process.env.SESSION_MAX_AGE_HOURS, 168),
  /**
   * The first admin, created at startup when ADMIN_ID names an account that
   * does not exist yet (auth/bootstrap.ts). There is deliberately no default
   * password: an app that ships one is an app with a known-password admin on
   * every deployment that forgot to change it. Missing or too-short values are
   * refused loudly at startup, so nobody is left wondering why they cannot get
   * in.
   */
  adminId: (process.env.ADMIN_ID || "").trim(),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminName: (process.env.ADMIN_NAME || "").trim(),
  adminEmail: (process.env.ADMIN_EMAIL || "").trim(),
  /**
   * Login attempts per minute, refilled continuously, in the same in-memory
   * token-bucket shape the upload limiter uses. Two buckets because they stop
   * two different attacks: the per-id one stops a password list being run
   * against one account (10/min ~= 14,400 guesses a day against a 32MiB-per-
   * guess KDF), the per-IP one stops one host working through many accounts.
   * The per-IP number is the looser of the two on purpose — a whole office can
   * share one address, and locking out the office to slow one attacker is a
   * bad trade.
   */
  loginAttemptsPerMinutePerId: toInt(process.env.LOGIN_ATTEMPTS_PER_MINUTE, 10),
  loginAttemptsPerMinutePerIp: toInt(process.env.LOGIN_ATTEMPTS_PER_IP_PER_MINUTE, 30),
};

/* ------------------------------------------------------------------ 설정 검증 */

/**
 * 설정을 읽고 나서 **말이 되는지** 본다.
 *
 * 왜 따로 두는가: 위의 파서들은 무엇이 오든 기본값으로 떨어진다. 그건 의도한
 * 것이다 — 오타 하나로 서비스가 못 뜨는 것보다 낫다는 판단이고, 그 판단은
 * 지금도 유효하다. 문제는 **아무도 모른다**는 것이었다. RAG_DOC_MAX_BYTES=abc
 * 는 조용히 512KB 가 되고, 몇 주 뒤 "왜 큰 문서가 안 올라가지" 로 돌아온다.
 *
 * 그래서 값은 그대로 떨어뜨리되, 떨어졌다는 사실을 기동 때 말한다. 여기서
 * 다시 process.env 를 읽는 이유도 그것이다 — 파서를 거친 뒤의 값은 이미
 * 멀쩡해 보여서, 원본을 봐야 오타를 알 수 있다.
 */
export interface ConfigProblem {
  key: string;
  value: string;
  message: string;
}

type Kind = "int" | "port" | "ratio" | "ms" | "url" | "bool" | "dir" | "level" | "crash";

interface Rule {
  key: string;
  kind: Kind;
  /** ms 종류의 하한. 파서가 이 아래를 기본값으로 되돌리므로 같이 본다. */
  minMs?: number;
}

const RULES: Rule[] = [
  { key: "PORT", kind: "port" },
  { key: "LOG_LEVEL", kind: "level" },
  { key: "CRASH_POLICY", kind: "crash" },
  { key: "SHUTDOWN_GRACE_MS", kind: "int" },
  { key: "DATA_DIR", kind: "dir" },
  { key: "LOG_DIR", kind: "dir" },
  { key: "TOOL_FS_ROOT", kind: "dir" },
  { key: "TOOL_TIMEOUT_MS", kind: "ms" },
  { key: "TOOL_HTTP_TIMEOUT_MS", kind: "ms" },
  { key: "TOOL_MAX_RESULT_BYTES", kind: "int" },
  { key: "TOOL_MAX_ROUNDS", kind: "int" },
  { key: "CONTEXT_COMPACT_RATIO", kind: "ratio" },
  { key: "CONTEXT_KEEP_RECENT_RATIO", kind: "ratio" },
  { key: "CONTEXT_MAX_COMPACTIONS", kind: "int" },
  { key: "NORMAL_MODE_DEADLINE_MS", kind: "ms" },
  { key: "ATTACHMENT_MAX_IMAGE_BYTES", kind: "int" },
  { key: "ATTACHMENT_MAX_TEXT_BYTES", kind: "int" },
  { key: "ATTACHMENT_MAX_PER_MESSAGE", kind: "int" },
  { key: "ATTACHMENT_UPLOADS_PER_MINUTE", kind: "int" },
  { key: "MCP_DISCOVERY_TTL_MS", kind: "ms" },
  { key: "MCP_TIMEOUT_MS", kind: "ms" },
  { key: "MCP_DEBUG_TOOLS_HASH", kind: "bool" },
  { key: "RAG_ENGINE_URL", kind: "url" },
  { key: "RAG_MCP_URL", kind: "url" },
  { key: "RAG_CHUNK_MODEL_URL", kind: "url" },
  { key: "RAG_DOC_MAX_BYTES", kind: "int" },
  { key: "RAG_PDF_MAX_BYTES", kind: "int" },
  { key: "GITLAB_MCP_URL", kind: "url" },
  { key: "GITLAB_URL", kind: "url" },
  { key: "TAVILY_API_URL", kind: "url" },
  { key: "SESSION_MAX_AGE_HOURS", kind: "int" },
  { key: "COOKIE_SECURE", kind: "bool" },
  { key: "LOGIN_ATTEMPTS_PER_MINUTE", kind: "int" },
  { key: "LOGIN_ATTEMPTS_PER_IP_PER_MINUTE", kind: "int" },
];

function checkValue(rule: Rule, raw: string): string | null {
  switch (rule.kind) {
    case "port": {
      const n = Number.parseInt(raw, 10);
      return Number.isInteger(n) && n > 0 && n < 65536 ? null : "1~65535 사이의 포트여야 합니다";
    }
    case "int": {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? null : "0 이상의 정수여야 합니다";
    }
    case "ratio": {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? null : "0 보다 크고 1 이하인 소수여야 합니다";
    }
    case "ms": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return "밀리초(숫자)여야 합니다";
      // 파서가 1초 미만을 기본값으로 되돌린다. 값이 살아남지 못한다는 뜻이다.
      return n >= (rule.minMs ?? 1000) ? null : `${rule.minMs ?? 1000}ms 이상이어야 합니다 (그보다 작으면 무시됩니다)`;
    }
    case "bool":
      return /^(0|1|true|false|yes|no|on|off)$/i.test(raw.trim()) ? null : "true 또는 false 여야 합니다";
    case "url":
      try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:" ? null : "http 또는 https 주소여야 합니다";
      } catch {
        return "주소 형식이 올바르지 않습니다 (예: http://호스트:포트)";
      }
    case "level":
      return /^(debug|info|warn|error|silent)$/i.test(raw.trim()) ? null : "debug·info·warn·error·silent 중 하나여야 합니다";
    case "crash":
      return /^(exit|keep)$/i.test(raw.trim()) ? null : "exit 또는 keep 이어야 합니다";
    case "dir":
      // 있는지까지만 본다. 만들 수 있는지는 실제로 쓸 때 알게 되고, 여기서
      // 디렉터리를 만들어 버리면 오타난 경로가 조용히 생겨난다.
      return raw.trim() ? null : "빈 값일 수 없습니다";
  }
}

/**
 * 기동을 막을 문제와, 알려만 줄 문제를 갈라서 돌려준다.
 *
 * 가르는 기준은 "이대로 뜨면 사람이 속는가" 이다. 오타난 숫자는 기본값으로
 * 돌아 서비스는 되지만 운영자가 설정한 값은 아무 데도 없다 — 그래서 막는다.
 * 반쪽만 채운 설정(주소는 있는데 토큰이 없는 식)도 같은 이유로 막는다:
 * 기능이 조용히 사라지고, 왜 없는지는 아무 데도 안 적힌다.
 */
export function inspectConfig(env: NodeJS.ProcessEnv = process.env): {
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
} {
  const errors: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];

  for (const rule of RULES) {
    const raw = env[rule.key];
    // 설정하지 않은 값은 문제가 아니다 — 기본값을 쓰겠다는 뜻이다.
    if (raw === undefined || raw.trim() === "") continue;
    const message = checkValue(rule, raw);
    if (message) errors.push({ key: rule.key, value: raw, message });
  }

  // 짝이 있어야 뜻이 통하는 것들.
  const pairs: Array<[string, string, string]> = [
    ["GITLAB_MCP_URL", "GITLAB_TOKEN", "둘 다 있어야 GitLab MCP 가 등록됩니다"],
    ["RAG_CHUNK_MODEL_URL", "RAG_CHUNK_MODEL", "둘 다 있어야 모델 청킹을 씁니다"],
  ];

  // 관리자 짝은 **막지 않는다**. ensureAdminFromEnv() 는 첫 기동에만 계정을
  // 만들고, 만들고 난 뒤에는 비밀번호를 .env 에서 빼는 것이 옳은 운영이다 —
  // 그 상태를 오류로 보면 정상적으로 굴러가던 서버가 재기동에서 멈춘다.
  // (실제로 107 배포가 이 규칙에 걸려 안 떴다. 규칙 쪽이 틀렸다.)
  if (Boolean(env.ADMIN_ID?.trim()) !== Boolean(env.ADMIN_PASSWORD?.trim())) {
    warnings.push({
      key: env.ADMIN_ID?.trim() ? "ADMIN_PASSWORD" : "ADMIN_ID",
      value: "(비어 있음)",
      message: "한쪽만 설정되어 있습니다 — 관리자 계정이 아직 없다면 만들어지지 않습니다",
    });
  }
  for (const [a, b, why] of pairs) {
    const hasA = Boolean(env[a]?.trim());
    const hasB = Boolean(env[b]?.trim());
    if (hasA !== hasB) {
      errors.push({ key: hasA ? b : a, value: "(비어 있음)", message: `${why} — ${hasA ? a : b} 만 설정되어 있습니다` });
    }
  }

  // 막을 일은 아니지만 말해 둘 것.
  if (env.RAG_MCP_URL?.trim() && !env.MCP_IDENTITY_TOKEN?.trim()) {
    warnings.push({
      key: "MCP_IDENTITY_TOKEN",
      value: "(비어 있음)",
      message: "RAG MCP 는 등록되지만 누가 묻는지 전하지 않아, 모두가 공용 문서만 보게 됩니다",
    });
  }
  for (const key of ["RAG_MCP_URL", "GITLAB_MCP_URL"]) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      const allowed = (env.MCP_ALLOW_HTTP_HOSTS || "").toLowerCase();
      if (new URL(raw).protocol === "http:" && !allowed.split(",").map((h) => h.trim()).includes(host)) {
        errors.push({
          key: "MCP_ALLOW_HTTP_HOSTS",
          value: env.MCP_ALLOW_HTTP_HOSTS || "(비어 있음)",
          message: `${key} 가 http 인데 ${host} 가 허용 목록에 없습니다 — 이 서버는 호출되지 못합니다`,
        });
      }
    } catch {
      // 주소 형식 문제는 위에서 이미 잡았다.
    }
  }

  return { errors, warnings };
}

/** 기동 직전에 부른다. 문제가 있으면 전부 보여 주고 던진다 — 하나씩 고치게 하지 않는다. */
export function assertConfigValid(env: NodeJS.ProcessEnv = process.env): void {
  const { errors, warnings } = inspectConfig(env);
  for (const w of warnings) console.warn(`[config] 주의  ${w.key}=${w.value} — ${w.message}`);
  if (errors.length === 0) return;
  const lines = errors.map((e) => `  ${e.key}=${e.value} — ${e.message}`);
  throw new Error(`설정에 문제가 ${errors.length}건 있어 기동하지 않습니다.\n${lines.join("\n")}`);
}
