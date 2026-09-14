import { config } from "../config.js";
import { assertPublicHostname } from "../tools/net/ssrf.js";
import { listEndpoints } from "../vllm/endpoints.js";

/**
 * A hand-written MCP client for the "streamable HTTP" transport, protocol
 * version 2025-06-18. No dependency is added for it: the whole protocol we use
 * is four JSON-RPC methods over POST, and the repo already hand-writes its SSE
 * parser (vllm/client.ts) and its .env parser.
 *
 * The transport in one paragraph: every request is a POST of one JSON-RPC
 * message to the single server URL. The answer comes back EITHER as
 * `application/json` (one message) OR as `text/event-stream`, where the server
 * may push progress notifications before the response that actually answers our
 * id. A notification we send (`notifications/initialized`) has no id and is
 * answered with 202 and no body. If the server hands out an `Mcp-Session-Id` on
 * initialize, every later request in that session must echo it back.
 *
 * VERIFIED against https://mcp.deepwiki.com/mcp: initialize negotiates
 * 2025-06-18, the responses come back as SSE, and tools/list returns 3 tools.
 *
 * ONE SESSION PER OPERATION, deliberately. A tool call costs three round trips
 * (initialize, initialized, tools/call) instead of one, which at ~200ms RTT is
 * ~0.6s of an 8s budget. Holding sessions open across calls would mean owning
 * their expiry, their invalidation on a 404, and a per-owner pool keyed by
 * credential — state that can go stale in ways a stateless call cannot.
 */

/** What we ask for. A server that speaks something else answers with its own version. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MAX_REDIRECTS = 3;
/** Hard cap while streaming one response body. The assembled text is capped again, lower, in toolAdapter.ts. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpTarget {
  url: string;
  /** Present only when the record's authMode is "header". */
  authHeaderName?: string;
  /** The owner's credential. Never logged, never returned by any route. */
  credential?: string;
  /**
   * Headers the APPLICATION asserts, as opposed to the owner's credential
   * above: who is asking, and the secret that makes the claim worth anything.
   *
   * Only ever populated for a server whose record opts in (toolAdapter.ts), so
   * a user's identity does not travel to whatever third-party endpoint happens
   * to be in the registry.
   */
  identityHeaders?: Record<string, string>;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSession {
  target: McpTarget;
  /** Null when the server is stateless and issued no session id. */
  sessionId: string | null;
  /** What the server answered with, which may not be what we asked for. */
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
}

export interface McpContentPart {
  type: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
}

export interface McpCallResult {
  content: McpContentPart[];
  isError: boolean;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

let nextRequestId = 1;

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Hostnames of every serving endpoint, env and .model file alike. Read fresh on
 * every check rather than captured once: an endpoint added through
 * /api/models/endpoints has to be protected from the moment it is added, not
 * from the next restart.
 */
function modelServerHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const endpoint of [...listEndpoints(), ...config.vllmEndpoints]) {
    try {
      hosts.add(stripBrackets(new URL(endpoint.baseUrl).hostname).toLowerCase());
    } catch {
      // A malformed endpoint URL protects nothing and must not break the check.
    }
  }
  return hosts;
}

/**
 * Everything that has to be true of a URL before we send anything to it, run
 * again on EVERY redirect hop — a first hop that passes and then redirects to
 * localhost is exactly the attack the per-hop re-validation exists to stop.
 *
 * The model-server rule is the one that is not obvious: assertPublicHostname
 * only refuses private/loopback/link-local addresses, and this deployment's
 * vLLM servers are on public IPs reachable from inside the container (host
 * networking). Without this an MCP server pointed at the 27B endpoint would be an
 * authenticated proxy into the model servers, using the container's network
 * position.
 */
async function assertAllowedUrl(url: URL): Promise<void> {
  const hostname = stripBrackets(url.hostname).toLowerCase();
  if (!hostname) throw new Error("MCP 서버 주소에 호스트가 없습니다.");
  // http only where the operator named the host in .env. Every other rule below
  // still applies to it — this exempts the transport, not the destination.
  if (url.protocol !== "https:" && !config.mcpAllowHttpHosts.includes(hostname)) {
    throw new Error(`MCP 서버 주소는 https만 허용합니다 (받은 값: ${url.protocol}//).`);
  }
  if (config.mcpAllowedHosts.length > 0 && !config.mcpAllowedHosts.includes(hostname)) {
    throw new Error(`허용되지 않은 호스트입니다 (MCP_ALLOWED_HOSTS): ${hostname}`);
  }
  if (modelServerHosts().has(hostname)) {
    throw new Error(`모델 서버와 같은 호스트는 MCP 서버로 등록할 수 없습니다: ${hostname}`);
  }
  await assertPublicHostname(hostname);
}

/** Public so the routes can refuse a bad URL before anything is written to disk. */
export async function assertRegisterableUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("올바른 URL이 아닙니다.");
  }
  await assertAllowedUrl(url);
  return url;
}

/**
 * POST with redirects followed by hand, re-validating every hop. `fetch`'s own
 * redirect handling would follow a Location we never got to look at.
 */
async function postGuarded(startUrl: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertAllowedUrl(current);
    const res = await fetch(current, { method: "POST", headers, body, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Location 없는 리다이렉트 응답입니다 (HTTP ${res.status}).`);
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current);
      continue;
    }
    return res;
  }
  throw new Error(`리다이렉트가 ${MAX_REDIRECTS}회를 넘었습니다.`);
}

/** Read a response body with a hard byte cap, cancelling the stream past it. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (received > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * SSE events to JSON-RPC messages, in the same shape as vllm/client.ts's
 * parseSseStream: split on blank lines, take `data:` lines, drop a fragment
 * that will not parse rather than failing the whole response.
 */
function parseSseMessages(raw: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const part of raw.split("\n\n")) {
    for (const rawLine of part.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trimStart();
      if (!payload || payload === "[DONE]") continue;
      try {
        messages.push(JSON.parse(payload) as JsonRpcMessage);
      } catch {
        // Malformed fragment — skip it, exactly as the vLLM parser does.
      }
    }
  }
  return messages;
}

function parseMessages(contentType: string, body: string): JsonRpcMessage[] {
  if (contentType.toLowerCase().includes("text/event-stream")) return parseSseMessages(body);
  if (!body.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`JSON이 아닌 응답을 받았습니다: ${body.slice(0, 120)}`);
  }
  return Array.isArray(parsed) ? (parsed as JsonRpcMessage[]) : [parsed as JsonRpcMessage];
}

function baseHeaders(target: McpTarget, session: McpSession | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Both, because the server picks: one JSON body or an SSE stream.
    Accept: "application/json, text/event-stream",
    "User-Agent": "qwen3-web-chat-mcp/1.0",
    "MCP-Protocol-Version": session?.protocolVersion ?? MCP_PROTOCOL_VERSION,
  };
  if (target.authHeaderName && target.credential) {
    headers[target.authHeaderName] = target.credential;
  }
  // After the credential, and deliberately: these are set by us, from config,
  // and must not be overwritten by a value an owner typed into a form.
  for (const [name, value] of Object.entries(target.identityHeaders ?? {})) {
    headers[name] = value;
  }
  if (session?.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  return headers;
}

/** One JSON-RPC request/response pair. Throws on HTTP, transport or JSON-RPC errors. */
async function request(
  target: McpTarget,
  session: McpSession | null,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ result: unknown; sessionId: string | null }> {
  const id = nextRequestId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const res = await postGuarded(target.url, baseHeaders(target, session), body, signal);
  const contentType = res.headers.get("content-type") || "";
  const text = await readCapped(res);
  if (!res.ok) {
    throw new Error(`${method} 요청이 HTTP ${res.status}로 실패했습니다: ${text.slice(0, 300)}`);
  }
  const messages = parseMessages(contentType, text);
  // Anything without our id is a server-initiated notification or request
  // (progress, logging, sampling). We do not answer those; we skip them.
  const answer = messages.find((m) => m.id === id);
  if (!answer) {
    throw new Error(`${method} 응답에 요청 id가 없습니다 (메시지 ${messages.length}개).`);
  }
  if (answer.error) {
    throw new Error(`${method} 오류 ${answer.error.code ?? "?"}: ${answer.error.message ?? "알 수 없는 오류"}`);
  }
  return { result: answer.result, sessionId: res.headers.get("mcp-session-id") };
}

/** A notification has no id, so there is no response to match — only a status to check. */
async function notify(target: McpTarget, session: McpSession, method: string, signal: AbortSignal): Promise<void> {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params: {} });
  const res = await postGuarded(target.url, baseHeaders(target, session), body, signal);
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`${method} 알림이 HTTP ${res.status}로 거부되었습니다.`);
}

/**
 * initialize + notifications/initialized. Until the notification is sent, a
 * spec-compliant server refuses everything else in the session.
 */
export async function openSession(target: McpTarget, signal: AbortSignal): Promise<McpSession> {
  const { result, sessionId } = await request(
    target,
    null,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // No capabilities are declared because none are implemented: we do not
      // serve roots, we do not answer sampling requests, and claiming either
      // would invite requests this client would ignore.
      capabilities: {},
      clientInfo: { name: "qwen3-web-chat", version: "0.1.0" },
    },
    signal,
  );
  const payload = (result ?? {}) as {
    protocolVersion?: unknown;
    serverInfo?: { name?: unknown; version?: unknown };
  };
  const session: McpSession = {
    target,
    sessionId,
    protocolVersion: typeof payload.protocolVersion === "string" ? payload.protocolVersion : MCP_PROTOCOL_VERSION,
    serverName: typeof payload.serverInfo?.name === "string" ? payload.serverInfo.name : "",
    serverVersion: typeof payload.serverInfo?.version === "string" ? payload.serverInfo.version : "",
  };
  await notify(target, session, "notifications/initialized", signal);
  return session;
}

/** tools/list, following `nextCursor` pages. Returns tools exactly as declared — sanitising is toolAdapter's job. */
export async function listMcpTools(session: McpSession, signal: AbortSignal): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = [];
  let cursor: string | undefined;
  // A server that keeps handing back cursors would page forever; five pages is
  // far more than the schema budget can hold anyway.
  for (let page = 0; page < 5; page++) {
    const { result } = await request(session.target, session, "tools/list", cursor ? { cursor } : {}, signal);
    const payload = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
    const listed = Array.isArray(payload.tools) ? payload.tools : [];
    for (const entry of listed) {
      const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof tool.name !== "string" || !tool.name) continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
            ? (tool.inputSchema as Record<string, unknown>)
            : {},
      });
    }
    if (typeof payload.nextCursor !== "string" || !payload.nextCursor) break;
    cursor = payload.nextCursor;
  }
  return tools;
}

/**
 * tools/call. A tool that fails reports it in `isError` with the reason in its
 * own content rather than as a JSON-RPC error, so both have to be handled: the
 * JSON-RPC error throws out of `request`, and this returns isError for the
 * caller to turn into a failed tool result.
 */
export async function callMcpTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<McpCallResult> {
  const { result } = await request(session.target, session, "tools/call", { name, arguments: args }, signal);
  const payload = (result ?? {}) as { content?: unknown; isError?: unknown };
  const content = Array.isArray(payload.content) ? (payload.content as McpContentPart[]) : [];
  return { content, isError: payload.isError === true };
}

export interface McpProbeResult {
  ok: boolean;
  /** Which step failed, so the refusal can name it in Korean. */
  stage?: "url" | "initialize" | "tools/list";
  error?: string;
  tools: McpToolDescriptor[];
  serverName?: string;
  protocolVersion?: string;
  latencyMs: number;
}

/**
 * initialize + tools/list under one budget, used by registration and by
 * discovery. Never throws: the caller reports the failure, it does not handle
 * an exception.
 */
export async function probeMcpServer(target: McpTarget, signal: AbortSignal): Promise<McpProbeResult> {
  const started = Date.now();
  let session: McpSession;
  try {
    await assertRegisterableUrl(target.url);
  } catch (err) {
    return { ok: false, stage: "url", error: message(err), tools: [], latencyMs: Date.now() - started };
  }
  try {
    session = await openSession(target, signal);
  } catch (err) {
    return { ok: false, stage: "initialize", error: message(err), tools: [], latencyMs: Date.now() - started };
  }
  try {
    const tools = await listMcpTools(session, signal);
    return {
      ok: true,
      tools,
      serverName: session.serverName,
      protocolVersion: session.protocolVersion,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      stage: "tools/list",
      error: message(err),
      tools: [],
      serverName: session.serverName,
      protocolVersion: session.protocolVersion,
      latencyMs: Date.now() - started,
    };
  }
}

function message(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout() surfaces as TimeoutError, whose own message ("The
    // operation was aborted due to timeout") says nothing about what timed out.
    if (err.name === "TimeoutError") return "응답 시간이 초과되었습니다.";
    if (err.name === "AbortError") return "요청이 중단되었습니다.";
    return err.message;
  }
  return String(err);
}
