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
 * REGISTERING adopts a server for the registrant and for nobody else's file:
 * publishing is not switching it on for the deployment. `hidden` is the
 * separate on/off switch for whether a server's tools currently run in a
 * conversation — orthogonal to adoption, and the same field for every origin
 * (builtin, self-registered or adopted). See `effectiveServers` below and
 * src/mcp/rules.ts `isMcpVisible`, which the two must always agree with.
 */

const EMPTY: OwnerMcpPrefs = { adopted: [], hidden: [], credentials: {} };

function lockKey(ownerId: string): string {
  return `mcp-owner:${ownerId}`;
}

/**
 * Tolerant of a missing file, a partial one, and anything hand-edited into the
 * wrong shape.
 *
 * A file written before `hidden` existed only has `optedOutBuiltins` — the old
 * name for "builtins this owner switched off". Folding it into `hidden` here
 * (read-side only, no migration write) is what keeps that old file working
 * exactly as before without a migration step: the next write replaces it with
 * the new shape anyway.
 */
function normalize(raw: unknown): OwnerMcpPrefs {
  const record = (raw ?? {}) as Partial<OwnerMcpPrefs> & { optedOutBuiltins?: unknown };
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : [];
  const credentials: Record<string, string> = {};
  if (record.credentials && typeof record.credentials === "object" && !Array.isArray(record.credentials)) {
    for (const [key, value] of Object.entries(record.credentials)) {
      if (typeof value === "string" && value.length > 0) credentials[key] = value;
    }
  }
  const hidden = new Set([...strings(record.hidden), ...strings(record.optedOutBuiltins)]);
  return { adopted: strings(record.adopted), hidden: [...hidden], credentials };
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
 * Take a user-registered server into (or out of) this owner's library — the
 * "담기" checkbox on something someone else shared. Meaningless for a builtin
 * (always a library member, see `effectiveServers`) and for a server this
 * owner registered themselves (always a member too), so this only ever needs
 * to touch `adopted`; `hidden` is a separate switch (see `setHidden`).
 */
export async function setAdoption(ownerId: string, server: McpServerRecord, adopted: boolean): Promise<OwnerMcpPrefs> {
  return mutate(ownerId, (prefs) => {
    const adoptedSet = new Set(prefs.adopted);
    if (adopted) adoptedSet.add(server.id);
    else adoptedSet.delete(server.id);
    return { ...prefs, adopted: [...adoptedSet] };
  });
}

/**
 * Switch a server's tools on or off for this owner's conversations —
 * independent of origin, so the same call turns off a builtin, something this
 * owner registered, or something they adopted. This is what the library
 * page's card switch and the picker's absence of a server both come from.
 */
export async function setHidden(ownerId: string, serverId: string, hidden: boolean): Promise<OwnerMcpPrefs> {
  return mutate(ownerId, (prefs) => {
    const hiddenSet = new Set(prefs.hidden);
    if (hidden) hiddenSet.add(serverId);
    else hiddenSet.delete(serverId);
    return { ...prefs, hidden: [...hiddenSet] };
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
 * The servers whose tools this owner's turns may use.
 *
 * THE FINAL RULE, shared word-for-word with src/mcp/rules.ts `isMcpVisible`
 * (a matrix of inputs checks the two never disagree): active && (builtin ||
 * registered by this owner || adopted by this owner) && not hidden by this
 * owner. Registering your own server or adopting someone else's used to be
 * two different ways onto this list, and un-adopting your OWN server used to
 * drop it from here while the picker kept showing it — this formula is the
 * fix, not just for tool assembly but for what the picker is allowed to show.
 */
export function effectiveServers(servers: McpServerRecord[], prefs: OwnerMcpPrefs, ownerId: string): McpServerRecord[] {
  const hidden = new Set(prefs.hidden);
  const adopted = new Set(prefs.adopted);
  return servers.filter((server) => {
    if (server.status !== "active") return false;
    if (hidden.has(server.id)) return false;
    return server.origin === "builtin" || server.createdBy === ownerId || adopted.has(server.id);
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
  /** serverId -> how many owners switched it off (`hidden`). */
  hidden: Map<string, number>;
  /** Owners with an mcp.json at all, which is the denominator for a builtin. */
  ownersWithPrefs: number;
}

/**
 * One pass over the owner directories. O(accounts) per call, which is why it is
 * called once per request and its result handed to every summary rather than
 * recomputed per server.
 */
export async function countAdoptions(): Promise<AdoptionCounts> {
  const counts: AdoptionCounts = { adopted: new Map(), hidden: new Map(), ownersWithPrefs: 0 };
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
    for (const id of prefs.hidden) {
      counts.hidden.set(id, (counts.hidden.get(id) ?? 0) + 1);
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
 * minus the ones that switched it off", which is the number the delete guard
 * and the UI both want: how many people lose tools if this goes away.
 */
export function adoptionCountFor(server: McpServerRecord, counts: AdoptionCounts, totalAccounts: number): number {
  if (server.origin !== "builtin") return counts.adopted.get(server.id) ?? 0;
  const hiddenCount = counts.hidden.get(server.id) ?? 0;
  return Math.max(totalAccounts - hiddenCount, 0);
}

/**
 * Drop a deleted server from every owner's file — adoption, hidden and
 * credential alike. Leaving a credential behind for an id that no longer exists
 * would keep a secret on disk for a server nobody can see any more.
 */
export async function forgetServerEverywhere(serverId: string): Promise<number> {
  let touched = 0;
  for (const ownerId of await ownerIdsWithPrefs()) {
    const before = await readOwnerPrefs(ownerId);
    const needsWork =
      before.adopted.includes(serverId) ||
      before.hidden.includes(serverId) ||
      Object.prototype.hasOwnProperty.call(before.credentials, serverId);
    if (!needsWork) continue;
    await mutate(ownerId, (prefs) => {
      const credentials = { ...prefs.credentials };
      delete credentials[serverId];
      return {
        adopted: prefs.adopted.filter((id) => id !== serverId),
        hidden: prefs.hidden.filter((id) => id !== serverId),
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
