/**
 * Contract every tool module must implement. Drop a new file into
 * server/tools/ exporting one of these, register it in server/tools/index.ts,
 * and it's available to the model — see README.md "Adding a tool".
 */
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
 * it (never the browser session id), so a second browser reaches the same files. Only read_attachment needs it —
 * every other tool ignores the second argument — but it is what scopes that
 * tool to one account's own files, so it is part of the contract rather than a
 * global the tool could be tricked out of.
 */
export interface ToolContext {
  ownerId: string;
  conversationId: string;
}
