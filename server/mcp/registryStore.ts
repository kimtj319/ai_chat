import fs from "node:fs/promises";
import crypto from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "../storage/atomic.js";
import { mcpServerFile, mcpServersDir } from "../storage/paths.js";
import { withLock } from "../storage/mutex.js";
import { config } from "../config.js";
import type { McpAuthMode, McpServerRecord } from "../types.js";

/**
 * The MCP registry on disk: ONE JSON FILE PER SERVER at
 * {DATA_DIR}/mcp/servers/{id}.json, written with the same atomic
 * temp-file+rename discipline as accounts and groups (storage/groupStore.ts).
 *
 * The registry is GLOBAL and readable by every signed-in account, which is why
 * it holds no secret of any kind. A credential belongs to the owner who entered
 * it and lives in their own file (mcp/ownerPrefs.ts).
 *
 * Uniqueness (name, slug) is enforced under ONE lock for the whole collection,
 * for the reason groupStore.ts states: per-id locking cannot make a name unique
 * across ids.
 */

const LOCK = "mcp-servers";

export const MAX_NAME_CHARS = 40;
/**
 * The description is REQUIRED and short: it is the one sentence a person reads
 * before ticking "adopt", and an empty one leaves them deciding blind.
 */
export const MAX_DESCRIPTION_CHARS = 200;
export const MIN_SLUG_CHARS = 2;
export const MAX_SLUG_CHARS = 32;
/**
 * Lowercase alphanumerics in hyphen-separated groups. NO UNDERSCORES, and that
 * is the whole point: the tool name is `mcp__{slug}__{tool}` with a DOUBLE
 * UNDERSCORE as the separator, so a slug containing one would make the boundary
 * ambiguous. Hyphens are safe because the function-name charset vLLM accepts
 * ([A-Za-z0-9_-]) includes them.
 *
 * At 32 characters a slug now eats half of the 64-character name budget, which
 * is why toolAdapter.ts drops (and logs) an over-long tool rather than
 * truncating it — that limit does real work here.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Ids we mint ourselves, so this only has to reject anything else. */
const ID_PATTERN = /^[a-z0-9]{8,32}$/;

/** Under TOOL_TIMEOUT_MS at the top, and above "instantly fails" at the bottom. */
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 9000;

export function normalizeServerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return ID_PATTERN.test(id) ? id : null;
}

export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_NAME_CHARS ? name : null;
}

/**
 * The slug is IMMUTABLE once written: it is inside the tool name the model sees
 * (`mcp__{slug}__{tool}`), and conversations have stored those names in their
 * tool calls. Renaming it would silently rewrite what those transcripts say
 * happened.
 */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  if (slug.length < MIN_SLUG_CHARS || slug.length > MAX_SLUG_CHARS) return null;
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/** Required. Null means "not a usable description", which is a 400, not a blank. */
export function normalizeDescription(raw: unknown): string | null {
  const text = normalizeOptionalText(raw, MAX_DESCRIPTION_CHARS);
  return text ? text : null;
}

/**
 * The same cleaning without the "must be present" rule, for the admin's
 * optional disable reason. Returns null only when the value is unusable.
 */
export function normalizeOptionalText(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return text.length <= max ? text : null;
}

export function clampTimeoutMs(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return Math.min(Math.max(config.mcpTimeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  return Math.min(Math.max(Math.trunc(parsed), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export function normalizeAuthMode(raw: unknown): McpAuthMode | null {
  return raw === "none" || raw === "header" ? raw : null;
}

/**
 * An HTTP header name, per RFC 7230 token rules. Anything else could inject a
 * second header into the request we build.
 */
export function normalizeHeaderName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(name) ? name : null;
}

export async function getServer(id: string): Promise<McpServerRecord | null> {
  const normalized = normalizeServerId(id);
  if (!normalized) return null;
  try {
    return await readJsonFile<McpServerRecord>(mcpServerFile(normalized));
  } catch (err) {
    console.warn(`[mcp] corrupt server file for "${normalized}":`, err);
    return null;
  }
}

/** Every registered server, name-sorted. A corrupt file is skipped, not fatal. */
export async function listServers(): Promise<McpServerRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(mcpServersDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const servers: McpServerRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const server = await getServer(entry.slice(0, -".json".length));
    if (server) servers.push(server);
  }
  servers.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return servers;
}

export interface CreateServerInput {
  name: string;
  slug: string;
  description: string;
  url: string;
  authMode: McpAuthMode;
  authHeaderName?: string;
  toolAllowlist?: string[];
  /** Builtin definitions only — see McpServerRecord.sendUserIdentity. */
  sendUserIdentity?: boolean;
  timeoutMs?: number;
  origin?: McpServerRecord["origin"];
  createdBy: string;
}

export type CreateServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; code: "duplicate_name" | "duplicate_slug" };

export async function createServer(input: CreateServerInput): Promise<CreateServerResult> {
  return withLock(LOCK, async () => {
    const existing = await listServers();
    if (existing.some((s) => s.name === input.name)) return { ok: false as const, code: "duplicate_name" as const };
    if (existing.some((s) => s.slug === input.slug)) return { ok: false as const, code: "duplicate_slug" as const };
    const now = new Date().toISOString();
    const server: McpServerRecord = {
      id: crypto.randomBytes(6).toString("hex"),
      name: input.name,
      slug: input.slug,
      description: input.description,
      transport: "http",
      url: input.url,
      origin: input.origin ?? "user",
      status: "active",
      authMode: input.authMode,
      ...(input.authMode === "header" && input.authHeaderName ? { authHeaderName: input.authHeaderName } : {}),
      ...(input.toolAllowlist?.length ? { toolAllowlist: input.toolAllowlist } : {}),
      ...(input.sendUserIdentity ? { sendUserIdentity: true } : {}),
      timeoutMs: clampTimeoutMs(input.timeoutMs),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFileAtomic(mcpServerFile(server.id), server);
    return { ok: true as const, server };
  });
}

/** Everything PATCH may change. `slug` is absent on purpose — it is immutable. */
export interface UpdateServerInput {
  name?: string;
  description?: string;
  url?: string;
  authMode?: McpAuthMode;
  authHeaderName?: string | null;
  timeoutMs?: number;
  /** Not reachable from PATCH: the route builds its patch field by field. */
  toolAllowlist?: string[];
  /** Not reachable from PATCH either, and for a stronger reason — see McpServerRecord.sendUserIdentity. */
  sendUserIdentity?: boolean;
  /**
   * Also not reachable from PATCH: only seeding sets it, to adopt a record that
   * predates its builtin definition. `origin` decides whether a server is on by
   * default or has to be adopted one owner at a time, so it is the difference
   * between shipping a feature and shipping a switch nobody finds.
   */
  origin?: McpServerRecord["origin"];
}

export type UpdateServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; code: "not_found" | "duplicate_name" };

export async function updateServer(id: string, patch: UpdateServerInput): Promise<UpdateServerResult> {
  const normalized = normalizeServerId(id);
  if (!normalized) return { ok: false as const, code: "not_found" as const };
  return withLock(LOCK, async () => {
    const existing = await listServers();
    const target = existing.find((s) => s.id === normalized);
    if (!target) return { ok: false as const, code: "not_found" as const };
    if (patch.name !== undefined && existing.some((s) => s.id !== normalized && s.name === patch.name)) {
      return { ok: false as const, code: "duplicate_name" as const };
    }
    const updated: McpServerRecord = {
      ...target,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.origin !== undefined ? { origin: patch.origin } : {}),
      ...(patch.authMode !== undefined ? { authMode: patch.authMode } : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutMs: clampTimeoutMs(patch.timeoutMs) } : {}),
      updatedAt: new Date().toISOString(),
    };
    // Empty means "every tool", which is the absence of the field rather than
    // an empty list — an empty list stored would read as "no tools at all".
    if (patch.toolAllowlist !== undefined) {
      if (patch.toolAllowlist.length > 0) updated.toolAllowlist = patch.toolAllowlist;
      else delete updated.toolAllowlist;
    }
    // Same shape, and the false case must REMOVE it: this is the switch that
    // decides whether every user's name leaves the building, so a record the
    // code no longer vouches for has to stop vouching.
    if (patch.sendUserIdentity !== undefined) {
      if (patch.sendUserIdentity) updated.sendUserIdentity = true;
      else delete updated.sendUserIdentity;
    }
    // authHeaderName only means something in "header" mode; leaving a stale one
    // behind after a switch to "none" would put it back on the next switch.
    const mode = updated.authMode;
    if (mode === "none") {
      delete updated.authHeaderName;
    } else if (patch.authHeaderName !== undefined) {
      if (patch.authHeaderName === null) delete updated.authHeaderName;
      else updated.authHeaderName = patch.authHeaderName;
    }
    await writeJsonFileAtomic(mcpServerFile(normalized), updated);
    return { ok: true as const, server: updated };
  });
}

/** Admin disable/enable. A disabled server contributes no tools to anyone. */
export async function setServerStatus(
  id: string,
  disabled: boolean,
  by: string,
  reason?: string,
): Promise<McpServerRecord | null> {
  const normalized = normalizeServerId(id);
  if (!normalized) return null;
  return withLock(LOCK, async () => {
    const target = await getServer(normalized);
    if (!target) return null;
    const now = new Date().toISOString();
    const updated: McpServerRecord = disabled
      ? {
          ...target,
          status: "disabled",
          disabledBy: by,
          disabledAt: now,
          ...(reason ? { disabledReason: reason } : {}),
          updatedAt: now,
        }
      : { ...target, status: "active", updatedAt: now };
    if (!disabled) {
      delete updated.disabledBy;
      delete updated.disabledAt;
      delete updated.disabledReason;
    }
    await writeJsonFileAtomic(mcpServerFile(normalized), updated);
    return updated;
  });
}

export async function deleteServer(id: string): Promise<boolean> {
  const normalized = normalizeServerId(id);
  if (!normalized) return false;
  return withLock(LOCK, async () => {
    try {
      await fs.unlink(mcpServerFile(normalized));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}
