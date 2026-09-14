import fs from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { userFile, usersDir } from "./paths.js";
import { withLock } from "./mutex.js";
import { hashPassword } from "../auth/password.js";
import type { UserRecord, UserRole, UserStatus } from "../types.js";

/**
 * Accounts on disk: ONE JSON FILE PER USER at {DATA_DIR}/auth/users/{id}.json,
 * written with the same atomic temp-file+rename discipline as conversations
 * (storage/atomic.ts) and serialised with the same per-key mutex
 * (storage/mutex.ts) conversationStore uses.
 *
 * Why no index file: an index is a second copy of the same truth. It has to be
 * rewritten under a lock spanning *all* users on every signup and every status
 * change, and when it disagrees with the records — a crash between the two
 * writes — the disagreement is silent: an account that can log in but is not
 * listed for the admin, or the reverse. A readdir over a directory holding tens
 * of files costs nothing, and each record is then its own consistency unit: one
 * lock per user, one file per user, no cross-record invariant to keep.
 */

/**
 * Ids are lowercased, and that is load-bearing rather than cosmetic: the id is
 * a path segment ({DATA_DIR}/owners/{id}) and macOS and Windows filesystems are
 * case-insensitive, so "Alice" and "alice" would be two accounts sharing one
 * conversation directory. Lowercasing makes "the same id" mean the same thing
 * to the store and to the filesystem.
 *
 * 3..32 of [a-z0-9_-] — a subset of storage/paths.ts ID_PATTERN, so a user id
 * is always a safe path segment.
 */
const ID_PATTERN = /^[a-z0-9_-]{3,32}$/;
const MAX_NAME_CHARS = 60;
const MAX_EMAIL_CHARS = 254;
/** Deliberately loose: a shape check, not an address validator. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return ID_PATTERN.test(id) ? id : null;
}

export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters would break the admin list and the log lines.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length > 0 && name.length <= MAX_NAME_CHARS ? name : null;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_CHARS && EMAIL_PATTERN.test(email) ? email : null;
}

export async function getUser(id: string): Promise<UserRecord | null> {
  const normalized = normalizeUserId(id);
  if (!normalized) return null;
  try {
    return await readJsonFile<UserRecord>(userFile(normalized));
  } catch (err) {
    console.warn(`[userStore] corrupt account file for ${normalized}:`, err);
    return null;
  }
}

export async function listUsers(): Promise<UserRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(usersDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const users: UserRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const id = normalizeUserId(entry.slice(0, -".json".length));
    if (!id) continue;
    const user = await getUser(id);
    if (user) users.push(user);
  }
  // Pending first — that part of the list is the admin's actual to-do — then
  // oldest signup first inside each group.
  const rank = (status: UserStatus): number => (status === "pending" ? 0 : status === "active" ? 1 : 2);
  users.sort((a, b) => rank(a.status) - rank(b.status) || (a.createdAt < b.createdAt ? -1 : 1));
  return users;
}

export type CreateUserResult = { ok: true; user: UserRecord } | { ok: false; code: "duplicate_id" };

/**
 * Create an account. New accounts are `pending` unless the caller says
 * otherwise — only the env bootstrap (auth/bootstrap.ts) creates an active one.
 *
 * The existence check and the write happen inside one per-id lock, so two
 * simultaneous signups for the same id cannot both see "free" and both write.
 */
export async function createUser(input: {
  id: string;
  name: string;
  email: string;
  password: string;
  status?: UserStatus;
  role?: UserRole;
}): Promise<CreateUserResult> {
  // Hashing is ~70ms of CPU; do it before taking the lock so a burst of signups
  // for one id does not serialise on the KDF.
  const passwordHash = await hashPassword(input.password);
  return withLock(`user:${input.id}`, async () => {
    if (await getUser(input.id)) return { ok: false, code: "duplicate_id" as const };
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: input.id,
      name: input.name,
      email: input.email,
      passwordHash,
      status: input.status ?? "pending",
      role: input.role ?? "user",
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFileAtomic(userFile(user.id), user);
    return { ok: true as const, user };
  });
}

/**
 * Replace one account's password hash. Null when there is no such account.
 *
 * Takes the already-derived hash rather than the plaintext: scrypt costs ~70ms
 * here, and hashing inside the lock would hold every other write for that same
 * account for the duration. Nothing about the account's status changes, so the
 * status fields are left exactly as they were.
 */
export async function setUserPassword(id: string, passwordHash: string): Promise<UserRecord | null> {
  const normalized = normalizeUserId(id);
  if (!normalized) return null;
  return withLock(`user:${normalized}`, async () => {
    const existing = await getUser(normalized);
    if (!existing) return null;
    const updated: UserRecord = { ...existing, passwordHash, updatedAt: new Date().toISOString() };
    await writeJsonFileAtomic(userFile(normalized), updated);
    return updated;
  });
}

/**
 * File an account under a group, or (groupId === null) take it out of one.
 * Null return means there is no such account. The group itself is not checked
 * here; the route does that, because only it can tell a missing group from a
 * deliberate "no group".
 */
export async function setUserGroup(id: string, groupId: string | null): Promise<UserRecord | null> {
  const normalized = normalizeUserId(id);
  if (!normalized) return null;
  return withLock(`user:${normalized}`, async () => {
    const existing = await getUser(normalized);
    if (!existing) return null;
    const { groupId: _dropped, ...rest } = existing;
    const updated: UserRecord = groupId
      ? { ...rest, groupId, updatedAt: new Date().toISOString() }
      : { ...rest, updatedAt: new Date().toISOString() };
    await writeJsonFileAtomic(userFile(normalized), updated);
    return updated;
  });
}

/** Take every account out of a group that is going away. Returns how many. */
export async function clearGroupFromUsers(groupId: string): Promise<number> {
  let cleared = 0;
  for (const user of await listUsers()) {
    if (user.groupId !== groupId) continue;
    if (await setUserGroup(user.id, null)) cleared += 1;
  }
  return cleared;
}

/**
 * Remove the account record. False when there was none.
 *
 * This deletes the record ONLY. Everything the account owned lives under
 * {DATA_DIR}/owners/{id} and its sessions live under {DATA_DIR}/sessions, and
 * the caller has to deal with both — see routes/admin.ts, which does. Leaving
 * either behind is not merely untidy: both are addressed by the id string
 * alone, so a later account registered with the same id would inherit the
 * previous holder's conversations and any session still pointing at the name.
 */
export async function deleteUser(id: string): Promise<boolean> {
  const normalized = normalizeUserId(id);
  if (!normalized) return false;
  return withLock(`user:${normalized}`, async () => {
    try {
      await fs.unlink(userFile(normalized));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

/**
 * Change one account's status. Null when there is no such account. `by` is the
 * admin's id, recorded so the admin list can show who approved or blocked it.
 */
export async function setUserStatus(id: string, status: UserStatus, by: string): Promise<UserRecord | null> {
  const normalized = normalizeUserId(id);
  if (!normalized) return null;
  return withLock(`user:${normalized}`, async () => {
    const existing = await getUser(normalized);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: UserRecord = { ...existing, status, updatedAt: now, statusChangedBy: by, statusChangedAt: now };
    await writeJsonFileAtomic(userFile(normalized), updated);
    return updated;
  });
}
