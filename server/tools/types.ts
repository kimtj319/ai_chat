/**
 * Contract every tool module must implement. Drop a new file into
 * server/tools/ exporting one of these, register it in server/tools/index.ts,
 * and it's available to the model — see README.md "Adding a tool".
 */
/**
 * Reserved namespace for tools discovered from an MCP server, whose names are
 * `mcp__{slug}__{tool}` (mcp/toolAdapter.ts). tools/index.ts refuses to load a
 * builtin that uses it. Here rather than in toolAdapter.ts so the registry can
 * import it without pulling in the MCP client.
 */
export const MCP_TOOL_PREFIX = "mcp__";

export interface ToolDefinition {
  name: string;
  description: string;
  category: string;
  /** JSON Schema object describing the arguments the model must supply. */
  parameters: Record<string, unknown>;
  execute(args: any, ctx?: ToolContext): Promise<unknown>;
}

/**
 * Which conversation the call is running in. `ownerId` is the account that owns
 * it (never the browser session id), so a second browser reaches the same files.
 * The tools that read it: read_attachment (scopes it to one account's own
 * files), web_search (that account's own search key), the schedule tools (which
 * conversation a task belongs to) and every MCP tool (that account's credential
 * and personal key). The rest ignore it. It is part of the contract rather than
 * a global so no tool can be tricked into acting for another account.
 */
export interface ToolContext {
  ownerId: string;
  conversationId: string;
  /** 이 턴에 크롬 제어가 켜져 있다 — 예약 도구가 크롬 작업인지 정할 때 쓴다. */
  browserControl?: boolean;
}
