import { callMcpTool, openSession, type McpCallResult, type McpToolDescriptor } from "./client.js";
import { noteCallFailure, noteCallSuccess, scheduleRefresh, snapshot } from "./discovery.js";
import { effectiveServers, getCredential, readOwnerPrefs } from "./ownerPrefs.js";
import { listServers } from "./registryStore.js";
import { config } from "../config.js";
import type { ToolDefinition } from "../tools/types.js";
import type { McpServerRecord, McpToolSummary } from "../types.js";

/**
 * MCP tools, adapted to this app's own ToolDefinition contract so that
 * everything downstream — the runner, the turn loop, the transcript — treats
 * them exactly like a builtin.
 *
 * The caps in this file all exist for the same reason: THE SCHEMA BLOCK IS A
 * FIXED COST IN EVERY PROMPT. It is sent on every round of every turn, it
 * cannot be shortened later, and a server we do not control decides what goes
 * in it. So an oversized, deeply nested or $ref-laden schema is cut down here,
 * at the boundary, rather than being passed through to the model.
 */

/** Reserved namespace. tools/index.ts refuses to load a builtin that uses it. */
export const MCP_TOOL_PREFIX = "mcp__";
/** What a server that takes our word for it reads the owner's id from. */
const MCP_USER_HEADER = "X-Mcp-User";

/** OpenAI/vLLM function names: 64 chars, and only these characters. */
const MAX_TOOL_NAME_CHARS = 64;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Per SERVER, not per tool: one server may not crowd out the rest of the prompt. */
const MAX_SCHEMA_BLOCK_BYTES = 8 * 1024;
/** Root counts as 1, so a property's property is the deepest that survives. */
const MAX_SCHEMA_DEPTH = 3;
const MAX_PROPERTIES = 40;
const MAX_DESCRIPTION_CHARS = 1024;
/** The assembled text handed back to the model; the raw body is capped at 1MB in client.ts. */
const MAX_RESULT_CHARS = 64 * 1024;

/**
 * Everything else is dropped. An allowlist rather than a denylist because the
 * risk is what a server sends that we have not thought about — `$ref` into a
 * `$defs` we removed, vendor extensions, a nested `$schema` — not what it sends
 * that we already know to remove.
 */
const SCHEMA_KEYS = new Set([
  "type",
  "description",
  "enum",
  "const",
  "default",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  // Kept because real servers use them for a plain "string or string[]"
  // argument: mcp.deepwiki.com's ask_question declares repoName that way, and
  // dropping the branch would leave the model a described argument with no
  // type at all.
  "anyOf",
  "oneOf",
]);

/** Dropped wherever they appear, including nested. A $ref is dropped, never resolved. */
const STRIPPED_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Control characters out of a description. Newlines and tabs stay: a schema
 * description is prose that reaches the prompt, and flattening it to one line
 * makes a multi-paragraph description unreadable without making it any safer.
 */
function cleanText(value: unknown, max = MAX_DESCRIPTION_CHARS): string {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

/**
 * One schema node. Returns undefined for anything that must be DROPPED — a
 * $ref, a non-object node, or a node that is already too deep — and the caller
 * removes the property that held it (and its `required` entry) rather than
 * leaving the model a name with no schema.
 */
function sanitizeNode(node: unknown, depth: number): Record<string, unknown> | undefined {
  if (!isPlainObject(node)) return undefined;
  if ("$ref" in node) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYS.has(key) || !SCHEMA_KEYS.has(key)) continue;
    if (key === "description") {
      const description = cleanText(value);
      if (description) out.description = description;
      continue;
    }
    if (key === "properties" || key === "items" || key === "anyOf" || key === "oneOf") continue; // depth-aware, below
    if (key === "required") {
      if (Array.isArray(value)) out.required = value.filter((v): v is string => typeof v === "string");
      continue;
    }
    out[key] = value;
  }

  // At the depth limit the node keeps its scalar constraints and loses its
  // children: a truncated shape the model can still fill in beats a name with
  // no schema at all.
  if (depth >= MAX_SCHEMA_DEPTH) {
    delete out.required;
    return out;
  }

  if (isPlainObject(node.properties)) {
    const properties: Record<string, unknown> = {};
    let kept = 0;
    for (const [name, child] of Object.entries(node.properties)) {
      if (kept >= MAX_PROPERTIES) break;
      const sanitized = sanitizeNode(child, depth + 1);
      if (!sanitized) continue;
      properties[name] = sanitized;
      kept++;
    }
    out.properties = properties;
    if (Array.isArray(out.required)) {
      // A required name whose schema we dropped would be an instruction the
      // model cannot follow.
      const filtered = (out.required as string[]).filter((name) => name in properties);
      if (filtered.length > 0) out.required = filtered;
      else delete out.required;
    }
  }

  if (node.items !== undefined) {
    const items = sanitizeNode(node.items, depth + 1);
    if (items) out.items = items;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    // A branch that sanitises away (a $ref, say) is dropped; a union with no
    // branch left is dropped entirely rather than offered as an empty choice.
    const kept = branches.map((branch) => sanitizeNode(branch, depth + 1)).filter((b): b is Record<string, unknown> => Boolean(b));
    if (kept.length > 0) out[key] = kept;
  }

  return out;
}

/**
 * The parameters object handed to vLLM. Forced to an object root whatever the
 * server declared: the chat-completions contract is that arguments arrive as a
 * JSON object, and a schema saying otherwise produces calls that cannot be
 * parsed.
 */
export function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeNode(schema, 1) ?? {};
  sanitized.type = "object";
  if (!isPlainObject(sanitized.properties)) sanitized.properties = {};
  return sanitized;
}

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
 * One MCP tool as a ToolDefinition.
 *
 * THE TIMEOUT IS OUR OWN. runner.ts wraps every tool in withTimeout, which
 * rejects the promise without cancelling the work behind it — for an outbound
 * HTTP request that means the socket stays open and the body keeps arriving
 * after the model has already been told the call failed. AbortSignal.timeout()
 * on the record's own (shorter) budget is what actually stops it.
 */
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
        const session = await openSession(
          {
            url: server.url,
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
    servers = effectiveServers(all, prefs).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
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
