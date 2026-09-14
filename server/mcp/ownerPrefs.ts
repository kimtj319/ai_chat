import fs from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "../storage/atomic.js";
import { isValidId, ownerMcpFile, ownersDir } from "../storage/paths.js";
import { withLock } from "../storage/mutex.js";
import type { McpServerRecord, OwnerMcpPrefs } from "../types.js";

/**
 * One owner's MCP preferences at {DATA_DIR}/owners/{ownerId}/mcp.json, beside
 * their conversations — so deleting an account (storage/ownerData.ts removes
 * the whole owner tree) takes their credentials with it.
 *
 * THIS IS THE ONLY FILE THAT EVER HOLDS A CREDENTIAL. The registry is global
 * and readable by everyone; a credential is one person's secret for one server,
 * so it is stored here, sent only in that person's own outbound requests, and
 * returned by no endpoint at all — `hasCredential`, a boolean, is the most any
 * response ever says about it.
 *
 * ADOPTION IS THE SWITCH. Registering a server writes it into the registrant's
 * own `adopted` and into nobody else's file: publishing a server is not
 * switching it on for the deployment. Builtins are the one deliberate
 * exception — they are on for everyone until an owner opts out, which is what
 * `optedOutBuiltins` records.
 */

const EMPTY: OwnerMcpPrefs = { adopted: [], optedOutBuiltins: [], credentials: {} };

function lockKey(ownerId: string): string {
  return `mcp-owner:${ownerId}`;
}

/** Tolerant of a missing file, a partial one, and anything hand-edited into the wrong shape. */
function normalize(raw: unknown): OwnerMcpPrefs {
  const record = (raw ?? {}) as Partial<OwnerMcpPrefs>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
  const credentials: Record<string, string> = {};
  if (record.credentials && typeof record.credentials === "object" && !Array.isArray(record.credentials)) {
    for (const [key, value] of Object.entries(record.credentials)) {
      if (typeof value === "string" && value.length > 0) credentials[key] = value;
    }
  }
  return { adopted: strings(record.adopted), optedOutBuiltins: strings(record.optedOutBuiltins), credentials };
}

export async function readOwnerPrefs(ownerId: string): Promise<OwnerMcpPrefs> {
  if (!isValidId(ownerId)) return { ...EMPTY };
  try {
    return normalize(await readJsonFile<OwnerMcpPrefs>(ownerMcpFile(ownerId)));
  } catch (err) {
    // A corrupt file must not lock someone out of the whole app; it costs them
    // their adoptions, and the next write rebuilds it.
    console.warn(`[mcp] corrupt mcp.json for owner "${ownerId}", treating it as empty:`, err);
    return { ...EMPTY };
  }
}

/** Read-modify-write under the owner's lock, the way conversations are mutated. */
async function mutate(ownerId: string, fn: (prefs: OwnerMcpPrefs) => OwnerMcpPrefs): Promise<OwnerMcpPrefs> {
  if (!isValidId(ownerId)) return { ...EMPTY };
  return withLock(lockKey(ownerId), async () => {
    const current = await readOwnerPrefs(ownerId);
    const next = fn(current);
    await writeJsonFileAtomic(ownerMcpFile(ownerId), next);
    return next;
  });
}

/**
 * Adopt or drop a server. For a BUILTIN this flips `optedOutBuiltins` instead,
 * because a builtin's default is "on": recording adoption for it would leave
 * every account that never opened the page without the tools everyone else has.
 */
export async function setAdoption(ownerId: string, server: McpServerRecord, adopted: boolean): Promise<OwnerMcpPrefs> {
  return mutate(ownerId, (prefs) => {
    if (server.origin === "builtin") {
      const optedOut = new Set(prefs.optedOutBuiltins);
      if (adopted) optedOut.delete(server.id);
      else optedOut.add(server.id);
      return { ...prefs, optedOutBuiltins: [...optedOut] };
    }
    const adoptedSet = new Set(prefs.adopted);
    if (adopted) adoptedSet.add(server.id);
    else adoptedSet.delete(server.id);
    return { ...prefs, adopted: [...adoptedSet] };
  });
}

/** null clears it. The value is written here and read nowhere but the outbound request. */
export async function setCredential(ownerId: string, serverId: string, credential: string | null): Promise<boolean> {
  const prefs = await mutate(ownerId, (current) => {
    const credentials = { ...current.credentials };
    if (credential === null || credential.length === 0) delete credentials[serverId];
    else credentials[serverId] = credential;
    return { ...current, credentials };
  });
  return Boolean(prefs.credentials[serverId]);
}

export async function getCredential(ownerId: string, serverId: string): Promise<string | undefined> {
  return (await readOwnerPrefs(ownerId)).credentials[serverId];
}

/**
 * The servers whose tools this owner's turns may use: every ACTIVE builtin they
 * have not opted out of, plus every ACTIVE server they adopted. A disabled
 * server is in neither, whoever adopted it.
 */
export function effectiveServers(servers: McpServerRecord[], prefs: OwnerMcpPrefs): McpServerRecord[] {
  const optedOut = new Set(prefs.optedOutBuiltins);
  const adopted = new Set(prefs.adopted);
  return servers.filter((server) => {
    if (server.status !== "active") return false;
    return server.origin === "builtin" ? !optedOut.has(server.id) : adopted.has(server.id);
  });
}

/** Every owner id with an mcp.json. The owners directory is the only index there is. */
async function ownerIdsWithPrefs(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(ownersDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter(isValidId);
}

export interface AdoptionCounts {
  /** serverId -> how many owners hold it in `adopted`. */
  adopted: Map<string, number>;
  /** serverId -> how many owners opted OUT of this builtin. */
  optedOutBuiltins: Map<string, number>;
  /** Owners with an mcp.json at all, which is the denominator for a builtin. */
  ownersWithPrefs: number;
}

/**
 * One pass over the owner directories. O(accounts) per call, which is why it is
 * called once per request and its result handed to every summary rather than
 * recomputed per server.
 */
export async function countAdoptions(): Promise<AdoptionCounts> {
  const counts: AdoptionCounts = { adopted: new Map(), optedOutBuiltins: new Map(), ownersWithPrefs: 0 };
  for (const ownerId of await ownerIdsWithPrefs()) {
    let prefs: OwnerMcpPrefs;
    try {
      const raw = await readJsonFile<OwnerMcpPrefs>(ownerMcpFile(ownerId));
      if (raw === null) continue;
      prefs = normalize(raw);
    } catch {
      continue;
    }
    counts.ownersWithPrefs++;
    for (const id of prefs.adopted) counts.adopted.set(id, (counts.adopted.get(id) ?? 0) + 1);
    for (const id of prefs.optedOutBuiltins) {
      counts.optedOutBuiltins.set(id, (counts.optedOutBuiltins.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * How many people a server is switched on for.
 *
 * For a user-registered server that is exactly the `adopted` count. For a
 * BUILTIN it cannot be — a builtin is on for accounts that have never written
 * an mcp.json at all — so it is reported as "accounts known to this store,
 * minus the ones that opted out", which is the number the delete guard and the
 * UI both want: how many people lose tools if this goes away.
 */
export function adoptionCountFor(server: McpServerRecord, counts: AdoptionCounts, totalAccounts: number): number {
  if (server.origin !== "builtin") return counts.adopted.get(server.id) ?? 0;
  const optedOut = counts.optedOutBuiltins.get(server.id) ?? 0;
  return Math.max(totalAccounts - optedOut, 0);
}

/**
 * Drop a deleted server from every owner's file — adoption, opt-out and
 * credential alike. Leaving a credential behind for an id that no longer exists
 * would keep a secret on disk for a server nobody can see any more.
 */
export async function forgetServerEverywhere(serverId: string): Promise<number> {
  let touched = 0;
  for (const ownerId of await ownerIdsWithPrefs()) {
    const before = await readOwnerPrefs(ownerId);
    const needsWork =
      before.adopted.includes(serverId) ||
      before.optedOutBuiltins.includes(serverId) ||
      Object.prototype.hasOwnProperty.call(before.credentials, serverId);
    if (!needsWork) continue;
    await mutate(ownerId, (prefs) => {
      const credentials = { ...prefs.credentials };
      delete credentials[serverId];
      return {
        adopted: prefs.adopted.filter((id) => id !== serverId),
        optedOutBuiltins: prefs.optedOutBuiltins.filter((id) => id !== serverId),
        credentials,
      };
    });
    touched++;
  }
  return touched;
}

/**
 * A credential to discover a server's tool list with, for the background warm
 * at boot where there is no calling owner. The registrant first, then any
 * adopter. Only the owner id is ever logged by the caller; the value never is.
 */
export async function findDiscoveryCredential(server: McpServerRecord): Promise<string | undefined> {
  if (server.authMode !== "header") return undefined;
  const registrant = await getCredential(server.createdBy, server.id);
  if (registrant) return registrant;
  for (const ownerId of await ownerIdsWithPrefs()) {
    const credential = (await readOwnerPrefs(ownerId)).credentials[server.id];
    if (credential) return credential;
  }
  return undefined;
}
