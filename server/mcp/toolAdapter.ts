import { callMcpTool, McpHttpError, McpRpcError, openSession, type McpCallResult, type McpToolDescriptor } from "./client.js";
import { noteCallFailure, noteCallSuccess, scheduleRefresh, snapshot } from "./discovery.js";
import { effectiveServers, getCredential, readOwnerPrefs } from "./ownerPrefs.js";
import { ALPHAVANTAGE_MCP_URL, ALPHAVANTAGE_SLUG, GITLAB_SLUG } from "./builtinServers.js";
import { listServers } from "./registryStore.js";
import { config } from "../config.js";
import { isPrivilegedOwner } from "../auth/privilege.js";
import { getPersonalKeys, type PersonalKeyName } from "../storage/personalKeys.js";
import { missingKeyMessage } from "../tools/missingKey.js";
import { MCP_TOOL_PREFIX, type ToolDefinition } from "../tools/types.js";
import { cleanText, isPlainObject, sanitizeInputSchema } from "./schemaSanitize.js";
import type { McpServerRecord, McpToolSummary } from "../types.js";

/**
 * MCP tools, adapted to this app's own ToolDefinition contract so that
 * everything downstream — the runner, the turn loop, the transcript — treats
 * them exactly like a builtin.
 *
 * The caps in this file all exist for the same reason: THE SCHEMA BLOCK IS A
 * FIXED COST IN EVERY PROMPT. It is sent on every round of every turn, it
 * cannot be shortened later, and a server we do not control decides what goes
 * in it. So an oversized, deeply nested or $ref-laden schema is cut down at the
 * boundary (schemaSanitize.ts per tool, the per-server budget here) rather than
 * being passed through to the model.
 */

export { MCP_TOOL_PREFIX };
/** What a server that takes our word for it reads the owner's id from. */
const MCP_USER_HEADER = "X-Mcp-User";

/** OpenAI/vLLM function names: 64 chars, and only these characters. */
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Per SERVER, not per tool: one server may not crowd out the rest of the prompt. */
const MAX_SCHEMA_BLOCK_BYTES = 8 * 1024;
/** The assembled text handed back to the model; the raw body is capped at 1MB in client.ts. */
const MAX_RESULT_CHARS = 64 * 1024;

/** `mcp__{slug}__{tool}` — the name the model sees and the transcript stores. */
export function mcpToolName(slug: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${slug}__${toolName}`;
}

/**
 * Image and resource parts are not dropped silently: the model is told the part
 * was there and that it cannot see it, which is the difference between "the
 * tool returned nothing" and "the tool returned something I cannot read".
 */
function renderContent(result: McpCallResult): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push(`[이미지 ${part.mimeType ?? "unknown"} 생략됨]`);
    } else if (part.type === "audio") {
      parts.push(`[오디오 ${part.mimeType ?? "unknown"} 생략됨]`);
    } else if (part.type === "resource" || part.type === "resource_link") {
      parts.push(`[리소스 ${part.uri ?? part.name ?? ""} 생략됨]`);
    } else {
      parts.push(`[${part.type} 콘텐츠 생략됨]`);
    }
  }
  const text = parts.join("\n");
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated]` : text;
}

/**
 * The tool itself said no — a repository that does not exist, a query with no
 * results — as opposed to the connection failing.
 *
 * The distinction is load-bearing and was NOT obvious: measured against
 * mcp.deepwiki.com, asking for a repository that does not exist comes back as a
 * perfectly healthy JSON-RPC response with isError:true, and counting three of
 * those as transport failures quarantines a server that is working exactly as
 * designed. A class rather than a pattern on the message, because the message
 * is the remote server's own prose and matching on it is guesswork.
 */
class McpToolReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolReportedError";
  }
}

/**
 * Who to say is asking, for a server that has opted in AND a token to prove it
 * with — both, or nothing at all.
 *
 * Sending the identity without the token would be pointless rather than
 * dangerous (the receiving server discards an unproven claim), but sending it
 * to a server that has not opted in would be a privacy leak with no upside, so
 * the gate is on the record and the token is what makes the claim count.
 */
function identityHeadersFor(server: McpServerRecord, ownerId: string): { identityHeaders: Record<string, string> } | undefined {
  if (!server.sendUserIdentity || !config.mcpIdentityToken || !ownerId) return undefined;
  return {
    identityHeaders: {
      [MCP_USER_HEADER]: ownerId,
      Authorization: config.mcpIdentityToken,
    },
  };
}

/**
 * Builtins that authenticate with a key in the URL. The stored URL carries the
 * shared key and is what discovery uses; a tool CALL carries the caller's own
 * key instead, and only an account that may use shared resources
 * (auth/privilege.ts) falls back to the shared one.
 */
const PERSONAL_KEY_SERVERS: Record<
  string,
  { key: PersonalKeyName; shared: () => string; url: (keys: string[], ownerId: string) => string; missing: string }
> = {
  [GITLAB_SLUG]: {
    key: "gitlab",
    shared: () => config.gitlabToken,
    // 토큰이 여러 개면 모두 싣는다 — gitlabmcp 가 토큰마다 볼 수 있는 프로젝트를 합친다.
    // me 는 묻는 계정의 아이디: 공용 봇 토큰으로는 "내 이슈"의 나를 알 수 없어서 싣는다
    // (사내 계정과 GitLab 아이디가 같다).
    url: (keys, ownerId) =>
      `${config.gitlabMcpUrl}?${[...keys.map((k) => `token=${encodeURIComponent(k)}`), `me=${encodeURIComponent(ownerId)}`].join("&")}`,
    missing: missingKeyMessage("GitLab(wisenut 이슈)", "GitLab 액세스 토큰, read_api 권한"),
  },
  [ALPHAVANTAGE_SLUG]: {
    key: "alphavantage",
    shared: () => config.alphavantageApiKey,
    url: (keys) => `${ALPHAVANTAGE_MCP_URL}?apikey=${encodeURIComponent(keys[0]!)}`,
    missing: missingKeyMessage("Alpha Vantage", "alphavantage.co 에서 무료 발급"),
  },
};

/**
 * The URL a tool call goes to. Without either key the call is refused as a
 * tool result — the server is healthy, the caller just has no key.
 */
export async function callUrlFor(server: McpServerRecord, ownerId: string): Promise<string> {
  const spec = server.origin === "builtin" ? PERSONAL_KEY_SERVERS[server.slug] : undefined;
  if (!spec) return server.url;
  const own = await getPersonalKeys(ownerId, spec.key);
  const keys = own.length > 0 ? own : (await isPrivilegedOwner(ownerId)) && spec.shared() ? [spec.shared()] : [];
  if (keys.length === 0) throw new McpToolReportedError(spec.missing);
  return spec.url(keys, ownerId);
}

/**
 * One MCP tool as a ToolDefinition.
 *
 * THE TIMEOUT IS OUR OWN. runner.ts wraps every tool in withTimeout, which
 * rejects the promise without cancelling the work behind it — for an outbound
 * HTTP request that means the socket stays open and the body keeps arriving
 * after the model has already been told the call failed. AbortSignal.timeout()
 * on the record's own (shorter) budget is what actually stops it.
 */
function toDefinition(server: McpServerRecord, tool: McpToolDescriptor, snapshotOwnerId: string): ToolDefinition {
  const name = mcpToolName(server.slug, tool.name);
  const description = cleanText(tool.description) || `${server.name}의 ${tool.name} 도구입니다.`;
  return {
    name,
    description,
    category: `mcp:${server.slug}`,
    parameters: sanitizeInputSchema(tool.inputSchema),
    async execute(args: unknown, ctx) {
      // ctx.ownerId at call time, so a credential entered after the turn began
      // is still the one used; the snapshot's owner is only the fallback.
      const ownerId = ctx?.ownerId ?? snapshotOwnerId;
      const credential = server.authMode === "header" ? await getCredential(ownerId, server.id) : undefined;
      const signal = AbortSignal.timeout(server.timeoutMs);
      try {
        const url = await callUrlFor(server, ownerId);
        const session = await openSession(
          {
            url,
            ...(server.authHeaderName ? { authHeaderName: server.authHeaderName } : {}),
            ...(credential ? { credential } : {}),
            ...(identityHeadersFor(server, ownerId) ?? {}),
          },
          signal,
        );
        const result = await callMcpTool(session, tool.name, isPlainObject(args) ? args : {}, signal);
        const text = renderContent(result);
        // A tool result the model can act on, not a sign the server is unwell:
        // it answered, and what it answered was "no".
        if (result.isError) throw new McpToolReportedError(text || `${tool.name} 호출이 실패했습니다.`);
        noteCallSuccess(server.id);
        return text;
      } catch (err) {
        // The tool answered and said no. Health is untouched, and the model
        // gets the reason as an ordinary failed tool result.
        if (err instanceof McpToolReportedError) throw err;
        // The server answered, and the answer was about THIS call: the model's
        // arguments (a JSON-RPC error) or this owner's credential (401/403).
        // Counting those would let one account's wrong key, or a model retrying
        // bad arguments three times, quarantine the server for every account.
        if (err instanceof McpRpcError || (err instanceof McpHttpError && (err.status === 401 || err.status === 403))) {
          throw err;
        }
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          noteCallFailure(server.id, `tools/call: ${server.timeoutMs}ms 초과`);
          throw new Error(`${server.name} 응답이 ${server.timeoutMs}ms를 넘어 중단했습니다.`);
        }
        // Everything left is the connection failing, which is what quarantine
        // is counting.
        const message = err instanceof Error ? err.message : String(err);
        noteCallFailure(server.id, `tools/call: ${message}`);
        throw err instanceof Error ? err : new Error(message);
      }
    },
  };
}

export interface OwnerMcpTools {
  tools: ToolDefinition[];
  /** Korean, for the turn's `notice` channel. Never a reason to fail a turn. */
  notices: string[];
}

/**
 * Every MCP tool this owner's turn may use, from the DISCOVERY CACHE ONLY.
 *
 * Nothing here touches the network. A stale entry schedules a background
 * refresh and the turn proceeds with what is cached, because a turn that waits
 * on someone else's server is a turn that hangs.
 *
 * Order is deterministic — (slug, toolName) — because the array's bytes are
 * what the model's prefill cache is keyed on.
 */
export async function mcpToolsForOwner(ownerId: string): Promise<OwnerMcpTools> {
  let servers: McpServerRecord[];
  try {
    const [all, prefs] = await Promise.all([listServers(), readOwnerPrefs(ownerId)]);
    servers = effectiveServers(all, prefs, ownerId).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  } catch (err) {
    // The registry being unreadable must never take a turn down with it.
    console.warn("[mcp] could not read the registry for this turn; continuing without MCP tools:", err);
    return { tools: [], notices: ["MCP 서버 목록을 읽지 못해 이번 답변에서는 MCP 도구를 사용할 수 없습니다."] };
  }

  const tools: ToolDefinition[] = [];
  const notices: string[] = [];
  for (const server of servers) {
    const state = snapshot(server.id);
    if (state.stale) scheduleRefresh(server);
    if (state.quarantined) {
      notices.push(`MCP 서버 "${server.name}"가 연속 실패로 일시 차단되어 이번 답변에서는 도구를 사용할 수 없습니다.`);
      continue;
    }
    if (state.tools.length === 0) {
      notices.push(
        state.health.state === "unknown"
          ? `MCP 서버 "${server.name}"의 도구 목록을 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.`
          : `MCP 서버 "${server.name}"에 연결하지 못해 이번 답변에서는 도구를 사용할 수 없습니다.`,
      );
      continue;
    }
    tools.push(...definitionsFor(server, state.tools, ownerId).definitions);
  }
  return { tools, notices };
}

export interface AdaptedTools {
  definitions: ToolDefinition[];
  /** What the API reports as the server's tools — name and description only. */
  summaries: McpToolSummary[];
  dropped: string[];
}

/**
 * Name checks, schema sanitising and the 8KB budget, in one place so the API
 * summary and the prompt always agree about which tools exist.
 *
 * A tool whose name will not fit is DROPPED, never truncated: a truncated name
 * is a name that collides with the next tool, and the model would call one
 * thing and reach another.
 */
export function definitionsFor(server: McpServerRecord, tools: McpToolDescriptor[], ownerId: string): AdaptedTools {
  const ordered = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const definitions: ToolDefinition[] = [];
  const summaries: McpToolSummary[] = [];
  const dropped: string[] = [];
  let blockBytes = 0;

  for (const tool of ordered) {
    const name = mcpToolName(server.slug, tool.name);
    if (name.length > MAX_TOOL_NAME_CHARS) {
      dropped.push(`${tool.name} (이름 ${name.length}자 > ${MAX_TOOL_NAME_CHARS}자)`);
      continue;
    }
    if (!TOOL_NAME_PATTERN.test(name)) {
      dropped.push(`${tool.name} (도구 이름에 사용할 수 없는 문자)`);
      continue;
    }
    const definition = toDefinition(server, tool, ownerId);
    const cost = Buffer.byteLength(
      JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }),
      "utf8",
    );
    if (blockBytes + cost > MAX_SCHEMA_BLOCK_BYTES) {
      dropped.push(`${tool.name} (스키마 ${MAX_SCHEMA_BLOCK_BYTES / 1024}KB 예산 초과)`);
      continue;
    }
    blockBytes += cost;
    definitions.push(definition);
    summaries.push({ name: definition.name, description: definition.description });
  }

  if (dropped.length > 0) {
    console.warn(`[mcp] ${server.slug}: dropped ${dropped.length} tool(s) — ${dropped.join("; ")}`);
  }
  return { definitions, summaries, dropped };
}

/** The tool list for one server as GET /api/mcp/servers reports it. */
export function toolSummaries(server: McpServerRecord, tools: McpToolDescriptor[]): McpToolSummary[] {
  return definitionsFor(server, tools, server.createdBy).summaries;
}
