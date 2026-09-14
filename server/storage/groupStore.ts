import fs from "node:fs/promises";
import crypto from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { groupFile, groupsDir } from "./paths.js";
import { withLock } from "./mutex.js";
import type { GroupRecord } from "../types.js";

/**
 * Groups on disk: ONE JSON FILE PER GROUP at {DATA_DIR}/auth/groups/{id}.json,
 * written with the same atomic temp-file+rename discipline as accounts.
 *
 * A group is a folder an admin sorts accounts into. It grants nothing and
 * refuses nothing — membership is recorded on the account (UserRecord.groupId)
 * and read by the admin list, and by nothing else in the request path. Keeping
 * it that way is deliberate: the moment a group decides what someone may do,
 * every route has to consult it, and this one does not.
 *
 * The id is generated rather than derived from the name, so renaming a group is
 * a one-field write and never has to move members between files.
 */

const MAX_NAME_CHARS = 40;

/** Ids we mint ourselves, so this only has to reject anything else. */
const ID_PATTERN = /^[a-z0-9]{8,32}$/;

export function normalizeGroupId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return ID_PATTERN.test(id) ? id : null;
}

export function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters would break the admin table and the log lines, and a
  // run of spaces would make two groups look identical in the list.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_NAME_CHARS ? name : null;
}

export async function getGroup(id: string): Promise<GroupRecord | null> {
  const normalized = normalizeGroupId(id);
  if (!normalized) return null;
  try {
    return await readJsonFile<GroupRecord>(groupFile(normalized));
  } catch (err) {
    console.warn(`[groupStore] corrupt group file for "${normalized}":`, err);
    return null;
  }
}

export async function listGroups(): Promise<GroupRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(groupsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const groups: GroupRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const group = await getGroup(entry.slice(0, -".json".length));
    if (group) groups.push(group);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return groups;
}

export type CreateGroupResult =
  | { ok: true; group: GroupRecord }
  | { ok: false; code: "duplicate_group" };

/**
 * Two groups with the same name would be indistinguishable in the admin list,
 * so the name is what has to be unique, even though the id is what identifies
 * the record. The check and the write share a single lock for the whole
 * collection: per-id locking cannot make a name unique across ids.
 */
export async function createGroup(name: string, by: string): Promise<CreateGroupResult> {
  return withLock("groups", async () => {
    const existing = await listGroups();
    if (existing.some((group) => group.name === name)) return { ok: false as const, code: "duplicate_group" as const };
    const now = new Date().toISOString();
    const group: GroupRecord = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      createdAt: now,
      updatedAt: now,
      createdBy: by,
    };
    await writeJsonFileAtomic(groupFile(group.id), group);
    return { ok: true as const, group };
  });
}

export type RenameGroupResult =
  | { ok: true; group: GroupRecord }
  | { ok: false; code: "not_found" | "duplicate_group" };

export async function renameGroup(id: string, name: string): Promise<RenameGroupResult> {
  const normalized = normalizeGroupId(id);
  if (!normalized) return { ok: false as const, code: "not_found" as const };
  return withLock("groups", async () => {
    const existing = await listGroups();
    const target = existing.find((group) => group.id === normalized);
    if (!target) return { ok: false as const, code: "not_found" as const };
    if (existing.some((group) => group.id !== normalized && group.name === name)) {
      return { ok: false as const, code: "duplicate_group" as const };
    }
    const updated: GroupRecord = { ...target, name, updatedAt: new Date().toISOString() };
    await writeJsonFileAtomic(groupFile(normalized), updated);
    return { ok: true as const, group: updated };
  });
}

/**
 * Removes the group record only. Accounts filed under it are NOT deleted — the
 * caller clears their `groupId`, because an account outliving a group is the
 * whole point of a group being a label rather than an owner.
 */
export async function deleteGroup(id: string): Promise<boolean> {
  const normalized = normalizeGroupId(id);
  if (!normalized) return false;
  return withLock("groups", async () => {
    try {
      await fs.unlink(groupFile(normalized));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}
