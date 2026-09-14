import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { sessionDir, sessionFile, sessionsDir } from "./paths.js";
import { withLock } from "./mutex.js";
import type { SessionRecord } from "../types.js";

/**
 * The session named by `candidateId` (already validated by the caller against
 * ID_PATTERN), or a fresh one when there is no usable candidate.
 *
 * NOT written to disk here. Since accounts exist, an anonymous request is a
 * request that is about to be refused, and persisting a record for each one
 * would let anyone with curl fill DATA_DIR one empty session.json at a time.
 * The record becomes a file at login (setSessionUser), which is the moment it
 * starts carrying anything worth remembering. The id itself is stable either
 * way — the cookie is echoed back unchanged, so an anonymous browser keeps one
 * session id across requests and that same id is the one login persists.
 */
export async function getOrCreateSession(candidateId: string | undefined): Promise<SessionRecord> {
  if (candidateId) {
    const existing = await readJsonFile<SessionRecord>(sessionFile(candidateId));
    if (existing) return existing;
    // A cookie with no record: either never signed in, or the record was wiped.
    // Keep the id so the browser is not handed a new cookie on every request.
    return { sessionId: candidateId, createdAt: new Date().toISOString() };
  }
  return { sessionId: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

/**
 * Sign this browser session in as `userId`, or (userId === null) sign it out.
 *
 * Login deliberately extends the session that already exists instead of minting
 * a parallel token: the `sid` cookie identifies the browser, and this field is
 * the only thing that makes it an authenticated session. Nothing about the
 * cookie itself changes.
 *
 * Note what is NOT stored here: the account's status. Authorisation re-reads the
 * account record on every request (middleware/auth.ts) precisely so blocking a
 * user takes effect on their next request instead of whenever their session
 * happens to expire.
 */
/**
 * Sign in, on a BRAND NEW session id, discarding the one the browser arrived
 * with.
 *
 * Reusing the visitor's id was the earlier behaviour and it is session
 * fixation: anyone who can get a known `sid` into someone else's browser before
 * they sign in ends up holding an authenticated session, because nothing about
 * the cookie changes when the sign-in succeeds. Rotating costs one extra write
 * and removes the whole class.
 */
export async function signInOnFreshSession(oldSessionId: string, userId: string): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const record: SessionRecord = {
    sessionId: crypto.randomUUID(),
    createdAt: now,
    userId,
    loggedInAt: now,
  };
  await writeJsonFileAtomic(sessionFile(record.sessionId), record);
  // The old record belonged to a visitor who was not signed in; nothing else
  // refers to it, and leaving it would grow the directory one file per login.
  await fs.rm(sessionDir(oldSessionId), { recursive: true, force: true }).catch(() => {});
  return record;
}

export async function setSessionUser(sessionId: string, userId: string | null): Promise<SessionRecord> {
  return withLock(`session:${sessionId}`, async () => {
    // Created here if it does not exist yet: getOrCreateSession deliberately
    // does not write one for an anonymous visitor, so login is where the file
    // first appears.
    const existing =
      (await readJsonFile<SessionRecord>(sessionFile(sessionId))) ?? { sessionId, createdAt: new Date().toISOString() };
    const { userId: _wasUser, loggedInAt: _wasAt, ...rest } = existing;
    const updated: SessionRecord = userId ? { ...rest, userId, loggedInAt: new Date().toISOString() } : rest;
    await writeJsonFileAtomic(sessionFile(sessionId), updated);
    return updated;
  });
}

/**
 * Sign every OTHER browser session belonging to `userId` out, keeping
 * `keepSessionId` alive. Returns how many were signed out.
 *
 * Changing a password is how someone shuts a thief out, so a change that left
 * the thief's session working would be the feature failing at the only job it
 * has. The session that made the change is spared, because signing the user
 * out of the browser they are standing in reads as an error, not as security.
 *
 * Sessions are keyed by `sid` alone with no index from user to session, so this
 * enumerates the directory. That is a full scan, which is affordable only
 * because it runs on a password change and nowhere else. The records are
 * emptied rather than deleted: setSessionUser already does exactly this under
 * the right per-session lock, and a stale cookie pointing at a session with no
 * user is the same "not signed in" that an unknown cookie produces.
 */
export async function signOutOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  return signOutSessions(userId, keepSessionId);
}

/**
 * Sign out every session of `userId`, sparing none. Used when the account is
 * being deleted: there is no session left worth keeping, and one that outlived
 * the record would attach itself to the next account registered under the same
 * id (middleware/auth.ts resolves a session to an account by id string).
 */
export async function signOutAllSessions(userId: string): Promise<number> {
  return signOutSessions(userId, null);
}

async function signOutSessions(userId: string, keepSessionId: string | null): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir());
  } catch (error) {
    // No sessions directory yet means there is nothing to sign out.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let signedOut = 0;
  for (const sessionId of entries) {
    if (sessionId === keepSessionId) continue;
    const record = await readJsonFile<SessionRecord>(sessionFile(sessionId));
    if (record?.userId !== userId) continue;
    await setSessionUser(sessionId, null);
    signedOut += 1;
  }
  return signedOut;
}
