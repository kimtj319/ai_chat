import { adoptionCountFor, countAdoptions, readOwnerPrefs, type AdoptionCounts } from "./ownerPrefs.js";
import { snapshot } from "./discovery.js";
import { toolSummaries } from "./toolAdapter.js";
import type { McpToolDescriptor } from "./client.js";
import { listUsers } from "../storage/userStore.js";
import type { McpServerRecord, McpServerSummary, OwnerMcpPrefs } from "../types.js";

// What the /api/mcp routes return per server (routes/mcp.ts), built for the
// CALLING owner: their credential flag, their adoption counts.

/**
 * The URL WITHOUT ITS QUERY, because a key can live there: the Alpha Vantage
 * builtin carries `?apikey=` since that server accepts no auth header, and this
 * summary goes to every signed-in account. The host is unaffected.
 */
function publicUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    return url.toString();
  } catch {
    return raw.split("?")[0]!;
  }
}

export function summarize(
  server: McpServerRecord,
  prefs: OwnerMcpPrefs,
  counts: AdoptionCounts,
  totalAccounts: number,
  tools: McpToolDescriptor[],
): McpServerSummary {
  const url = publicUrl(server.url);
  let host: string;
  try {
    host = new URL(server.url).host;
  } catch {
    host = url;
  }
  const state = snapshot(server.id);
  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    description: server.description,
    url,
    host,
    transport: server.transport,
    origin: server.origin,
    status: server.status,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    adoptedCount: adoptionCountFor(server, counts, totalAccounts),
    authMode: server.authMode,
    ...(server.authHeaderName ? { authHeaderName: server.authHeaderName } : {}),
    requiresCredential: server.authMode === "header",
    hasCredential: Boolean(prefs.credentials[server.id]),
    health: state.health,
    // The same adapter the prompt uses, so the list never advertises a tool the
    // model was not actually given (a dropped name, a schema over budget).
    tools: toolSummaries(server, tools),
    ...(server.disabledReason ? { disabledReason: server.disabledReason } : {}),
  };
}

/** Everything a summary needs that is the same for every server in one response. */
export async function summaryContext(ownerId: string): Promise<{ prefs: OwnerMcpPrefs; counts: AdoptionCounts; totalAccounts: number }> {
  const [prefs, counts, users] = await Promise.all([readOwnerPrefs(ownerId), countAdoptions(), listUsers()]);
  return { prefs, counts, totalAccounts: users.length };
}
