import crypto from "node:crypto";
import { config } from "../config.js";
import { probeMcpServer, type McpToolDescriptor } from "./client.js";
import { countAdoptions, findDiscoveryCredential } from "./ownerPrefs.js";
import { listServers } from "./registryStore.js";
import type { McpHealth, McpServerRecord } from "../types.js";

/**
 * The discovery cache: what tools each MCP server offers, and whether it is
 * answering at all.
 *
 * WHY A CACHE IS NOT OPTIONAL HERE. The tool schemas are a fixed cost in EVERY
 * prompt of every round of every turn, and the array handed to vLLM has to be
 * byte-identical across a turn (chat/toolLoop.ts: 33s versus 2.3s of prefill on
 * a 189k-token prompt when it changed mid-turn). A turn therefore NEVER goes to
 * the network for a tool list — it reads this cache, and a stale entry only
 * schedules a refresh for the next turn to pick up.
 *
 * IDENTITY MATTERS, not just contents. When a refresh finds the same tools, the
 * hash matches and the existing array object is kept, so nothing downstream can
 * accidentally build a different-but-equal array.
 *
 * QUARANTINE. Three consecutive failures and the server is left alone for 30
 * minutes. Without it, a server that is down is retried on every request by
 * every user, and each retry costs a DNS lookup and a connect timeout.
 */

const QUARANTINE_AFTER_FAILURES = 3;
const QUARANTINE_MS = 30 * 60 * 1000;
/** initialize + tools/list under one budget, the same one registration gets. */
export const DISCOVERY_BUDGET_MS = 10_000;

interface CacheEntry {
  health: McpHealth;
  /** Stable object identity while the hash is unchanged. */
  tools: McpToolDescriptor[];
  toolsHash: string;
  /** Epoch ms after which the next use should schedule a refresh. */
  expiresAt: number;
  consecutiveFailures: number;
  quarantinedUntil: number;
}

const cache = new Map<string, CacheEntry>();
/** One refresh per server at a time; a second caller joins the first one's promise. */
const inFlight = new Map<string, Promise<CacheEntry>>();

const EMPTY_TOOLS: McpToolDescriptor[] = [];

function hashTools(tools: McpToolDescriptor[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

export interface DiscoverySnapshot {
  health: McpHealth;
  tools: McpToolDescriptor[];
  /** True when the entry is past its TTL (or absent) and a refresh is due. */
  stale: boolean;
  quarantined: boolean;
}

const UNKNOWN: McpHealth = { state: "unknown" };

/** What the cache holds right now. Never touches the network. */
export function snapshot(serverId: string): DiscoverySnapshot {
  const entry = cache.get(serverId);
  const now = Date.now();
  if (!entry) return { health: UNKNOWN, tools: EMPTY_TOOLS, stale: true, quarantined: false };
  const quarantined = entry.quarantinedUntil > now;
  return {
    health: entry.health,
    // A quarantined server contributes nothing, whatever it last answered with.
    tools: quarantined ? EMPTY_TOOLS : entry.tools,
    stale: now >= entry.expiresAt,
    quarantined,
  };
}

/** Refresh now, ignoring the TTL. Used by POST /probe and by registration. */
export async function refresh(server: McpServerRecord, credential?: string): Promise<DiscoverySnapshot> {
  const existing = inFlight.get(server.id);
  if (existing) {
    await existing.catch(() => undefined);
    return snapshot(server.id);
  }
  const run = doRefresh(server, credential).finally(() => inFlight.delete(server.id));
  inFlight.set(server.id, run);
  await run.catch(() => undefined);
  return snapshot(server.id);
}

/**
 * Refresh only if the entry is missing or past its TTL, and never while the
 * server is quarantined. Awaited by the routes; fired and forgotten by a turn.
 */
export async function ensureFresh(server: McpServerRecord, credential?: string): Promise<DiscoverySnapshot> {
  const entry = cache.get(server.id);
  const now = Date.now();
  if (entry && now < entry.expiresAt) return snapshot(server.id);
  if (entry && entry.quarantinedUntil > now) return snapshot(server.id);
  return refresh(server, credential);
}

async function doRefresh(server: McpServerRecord, credential?: string): Promise<CacheEntry> {
  const resolved =
    server.authMode === "header" && credential === undefined ? await findDiscoveryCredential(server) : credential;
  const result = await probeMcpServer(
    {
      url: server.url,
      ...(server.authHeaderName ? { authHeaderName: server.authHeaderName } : {}),
      ...(resolved ? { credential: resolved } : {}),
    },
    AbortSignal.timeout(DISCOVERY_BUDGET_MS),
  );
  return result.ok
    ? recordSuccess(server, result.tools)
    : recordFailure(server.id, `${result.stage ?? "probe"}: ${result.error ?? "실패"}`);
}

function baseEntry(serverId: string): CacheEntry {
  return (
    cache.get(serverId) ?? {
      health: UNKNOWN,
      tools: EMPTY_TOOLS,
      toolsHash: hashTools(EMPTY_TOOLS),
      expiresAt: 0,
      consecutiveFailures: 0,
      quarantinedUntil: 0,
    }
  );
}

/**
 * A server may be allowed to contribute only some of what it offers (the record
 * carries the list; registryStore.ts sets it on a builtin). The cut belongs
 * HERE, before the hash: everything downstream — the identity kept across a
 * refresh, the health verdict, the debug hash — is defined by the array this
 * function stores, so a list filtered any later would not be the list those
 * describe.
 */
function allowedTools(server: McpServerRecord, tools: McpToolDescriptor[]): McpToolDescriptor[] {
  if (!server.toolAllowlist?.length) return tools;
  const allowed = new Set(server.toolAllowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}

function recordSuccess(server: McpServerRecord, offered: McpToolDescriptor[]): CacheEntry {
  const previous = baseEntry(server.id);
  const tools = allowedTools(server, offered);
  const toolsHash = hashTools(tools);
  // Same list: keep the array we already have, so the object identity the turn
  // snapshot was built from does not change under it.
  const kept = toolsHash === previous.toolsHash ? previous.tools : tools;
  const entry: CacheEntry = {
    health: {
      // "answered but offers nothing" is not "ok": a tool list that is empty
      // costs a probe every ten minutes and gives the model nothing.
      state: tools.length > 0 ? "ok" : "degraded",
      checkedAt: new Date().toISOString(),
      toolCount: tools.length,
    },
    tools: kept,
    toolsHash,
    expiresAt: Date.now() + config.mcpDiscoveryTtlMs,
    consecutiveFailures: 0,
    quarantinedUntil: 0,
  };
  cache.set(server.id, entry);
  if (toolsHash !== previous.toolsHash) {
    console.log(`[mcp] ${server.slug}: ${tools.length} tool(s) — ${tools.map((t) => t.name).join(", ") || "none"}`);
  }
  return entry;
}

/**
 * A failure. The last known tool list is kept (a blip should not empty every
 * prompt) until the third failure in a row, at which point the server is
 * quarantined and contributes nothing until the backoff expires.
 */
function recordFailure(serverId: string, error: string): CacheEntry {
  const previous = baseEntry(serverId);
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const quarantined = consecutiveFailures >= QUARANTINE_AFTER_FAILURES;
  const now = Date.now();
  const entry: CacheEntry = {
    health: {
      state: quarantined ? "quarantined" : "down",
      checkedAt: new Date().toISOString(),
      error,
      ...(previous.health.toolCount !== undefined ? { toolCount: previous.health.toolCount } : {}),
    },
    tools: previous.tools,
    toolsHash: previous.toolsHash,
    expiresAt: now + (quarantined ? QUARANTINE_MS : config.mcpDiscoveryTtlMs),
    consecutiveFailures,
    quarantinedUntil: quarantined ? now + QUARANTINE_MS : 0,
  };
  cache.set(serverId, entry);
  console.warn(
    `[mcp] ${serverId} discovery failed (${consecutiveFailures}x): ${error}` +
      (quarantined ? ` — quarantined for ${QUARANTINE_MS / 60000}분` : ""),
  );
  return entry;
}

/**
 * A tool call's own verdict, folded into the same health. A server whose
 * tools/list works but whose calls all fail is not healthy, and counting only
 * discovery would never notice.
 */
export function noteCallSuccess(serverId: string): void {
  const entry = cache.get(serverId);
  if (!entry || entry.consecutiveFailures === 0) return;
  cache.set(serverId, { ...entry, consecutiveFailures: 0, quarantinedUntil: 0 });
}

export function noteCallFailure(serverId: string, error: string): void {
  recordFailure(serverId, error);
}

/**
 * Seed the cache from a probe that has just run, so registering a server does
 * not immediately probe it a second time to find out what it already knows.
 */
export function prime(server: McpServerRecord, tools: McpToolDescriptor[]): DiscoverySnapshot {
  recordSuccess(server, tools);
  return snapshot(server.id);
}

/** Forget everything about a server — its URL or auth changed, or it is gone. */
export function invalidate(serverId: string): void {
  cache.delete(serverId);
  inFlight.delete(serverId);
}

/**
 * Fire-and-forget refresh for a stale entry, called from the turn path. The
 * turn itself uses whatever is cached right now; this is what makes the NEXT
 * turn current.
 */
export function scheduleRefresh(server: McpServerRecord, credential?: string): void {
  if (inFlight.has(server.id)) return;
  void ensureFresh(server, credential).catch((err) => {
    console.warn(`[mcp] background refresh for ${server.slug} failed:`, err);
  });
}

/**
 * Warm the cache at boot for every server somebody actually uses, so the first
 * turn after a restart has tools instead of an empty array that fills in one
 * turn later. Never awaited by the caller, and never fatal.
 */
export async function warm(): Promise<void> {
  const servers = (await listServers()).filter((s) => s.status === "active");
  if (servers.length === 0) return;
  const counts = await countAdoptions();
  // 누군가에게 보이는 서버만 미리 탐색한다. 기본 제공은 모두에게 보이고, 사용자
  // 서버는 가시성 규칙(ownerPrefs.effectiveServers)상 **등록자에게는 채택 없이도
  // 보인다** — 그러니 등록자가 있는 서버는 채택 수와 상관없이 탐색 대상이다.
  // 예전 조건(채택 수 > 0)은 규칙이 "채택해야 보임" 이던 시절의 것이라, 자기 서버
  // 의 채택을 풀어 둔 계정에서는 목록에 보이는데 기동 직후 도구가 빈 채였다.
  const wanted = servers.filter(
    (s) => s.origin === "builtin" || Boolean(s.createdBy) || (counts.adopted.get(s.id) ?? 0) > 0,
  );
  if (wanted.length === 0) return;
  console.log(`[mcp] warming discovery for ${wanted.length} server(s)`);
  // Four at a time: a probe is mostly waiting, and a restart should not open a
  // connection to every registered server at once.
  const queue = [...wanted];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await refresh(next).catch((err) => console.warn(`[mcp] warm failed for ${next.slug}:`, err));
    }
  });
  await Promise.all(workers);
}
