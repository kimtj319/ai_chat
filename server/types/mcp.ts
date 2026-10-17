/**
 * MCP (Model Context Protocol) integration.
 *
 * TRANSPORT: remote HTTP only — "streamable HTTP", the 2025-06-18 transport,
 * where every JSON-RPC request is one POST whose response is either a JSON body
 * or an SSE stream. stdio/npx servers are deliberately NOT supported: the
 * deployment runs this app as root with host networking and no resource limits,
 * so "register a server" would be "run an arbitrary command as root". The
 * `transport` field is stored anyway so that adding another one later is a new
 * value, not a migration of every record.
 */
export type McpTransport = "http";

/** "none" sends no credential; "header" sends `{authHeaderName}: {credential}`. */
export type McpAuthMode = "none" | "header";

/** builtin — seeded by the server at boot; user — registered through the API. */
export type McpServerOrigin = "builtin" | "user";

export type McpServerStatus = "active" | "disabled";

/**
 * unknown     — never probed since this process started.
 * ok          — initialize + tools/list succeeded.
 * degraded    — answered, but with no usable tool (empty list, or every tool
 *               dropped by the name/schema caps).
 * down        — unreachable, or answered with an error, fewer than 3 times running.
 * quarantined — 3 consecutive failures; no tools are offered and the next probe
 *               is 30 minutes away (discovery.ts).
 */
export type McpHealthState = "unknown" | "ok" | "degraded" | "down" | "quarantined";

export interface McpHealth {
  state: McpHealthState;
  checkedAt?: string;
  error?: string;
  toolCount?: number;
}

/**
 * ONE MCP server, at {DATA_DIR}/mcp/servers/{id}.json.
 *
 * The registry is GLOBAL and every signed-in account can read all of it, so it
 * holds NO SECRET — a credential lives in the adopting owner's own file
 * (mcp/ownerPrefs.ts) and never here, never in a response and never in a log.
 * The one exception is a builtin whose server authenticates by query parameter
 * instead of by header (Alpha Vantage): its key can only live inside `url`,
 * which is why routes/mcp.ts strips the query from every summary it builds.
 *
 * `slug` is immutable because it is inside the tool name the model is given
 * (`mcp__{slug}__{tool}`) and that name is what conversations have already
 * stored in their tool calls; renaming it would rewrite history.
 */
export interface McpServerRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  transport: McpTransport;
  /** https only. */
  url: string;
  origin: McpServerOrigin;
  status: McpServerStatus;
  authMode: McpAuthMode;
  authHeaderName?: string;
  /**
   * The tool names this server may contribute; absent or empty means all of
   * them. Set in code on a builtin definition only (mcp/builtinServers.ts) and
   * accepted by no route: it is how a server that offers 133 tools costs the
   * prompt sixteen instead.
   */
  toolAllowlist?: string[];
  /**
   * Send the signed-in owner's id to this server, so it can answer as that
   * person rather than as one shared account.
   *
   * Set in code on a builtin definition only (mcp/builtinServers.ts) and
   * accepted by no route, for the same reason `toolAllowlist` is — except that
   * here the cost of a mistake is not a missing tool but WHO EVERY USER IS,
   * handed to whichever endpoint the record happens to point at. A first-party
   * server we ship the address of can be told; something an admin typed into a
   * form cannot.
   */
  sendUserIdentity?: boolean;
  /** Clamped to 1000..9000 on write, so it always stays under TOOL_TIMEOUT_MS. */
  timeoutMs: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  disabledBy?: string;
  disabledAt?: string;
  disabledReason?: string;
}

/** One tool as the server described it, after sanitisation (mcp/toolAdapter.ts). */
export interface McpToolSummary {
  name: string;
  description: string;
}

/** What GET /api/mcp/servers returns per server, for the CALLING owner. */
export interface McpServerSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  url: string;
  /** `new URL(url).host` — what the UI shows without re-parsing the URL. */
  host: string;
  transport: McpTransport;
  origin: McpServerOrigin;
  status: McpServerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  adoptedCount: number;
  authMode: McpAuthMode;
  authHeaderName?: string;
  requiresCredential: boolean;
  /** Whether THIS owner has stored a credential. Never the value. */
  hasCredential: boolean;
  health: McpHealth;
  tools: McpToolSummary[];
  disabledReason?: string;
}

/**
 * One owner's MCP preferences, at {DATA_DIR}/owners/{ownerId}/mcp.json.
 *
 * `adopted` holds user-origin server ids the owner took into their library
 * (the "담기" checkbox on a server someone else shared) — it says nothing about
 * whether that server's tools currently run in a conversation.
 *
 * `hidden` is the on/off switch for tool availability, and applies to ANY
 * server the owner's library holds — builtin, self-registered or adopted
 * alike. This is the field the picker and the model both read (see
 * mcp/ownerPrefs.ts `effectiveServers` and src/mcp/rules.ts `isMcpVisible`,
 * which must agree). It replaces the old `optedOutBuiltins`, which only ever
 * covered builtins; `ownerPrefs.ts` still reads that old field name out of a
 * file written before this change, so nobody's saved preference is lost.
 */
export interface OwnerMcpPrefs {
  adopted: string[];
  hidden: string[];
  /** serverId -> credential. The only place a credential is ever written. */
  credentials: Record<string, string>;
}

/** Machine-readable refusal reason on the /api/mcp routes. */
export type McpErrorCode =
  | "invalid_input"
  | "duplicate_name"
  | "duplicate_slug"
  | "slug_immutable"
  | "not_found"
  | "forbidden"
  | "in_use"
  | "probe_failed";
