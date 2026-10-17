import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readJsonFile, readdirOrEmpty, writeJsonFileAtomic } from "./atomic.js";
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
 * The record becomes a file at login, which is the moment it starts carrying
 * anything worth remembering — and login writes it under a NEW id
 * (signInOnFreshSession), so the id an anonymous browser keeps across requests
 * is never the one that ends up signed in.
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

/**
 * Sign this browser session out: the record stays, without its account.
 *
 * Note what is never stored on a session: the account's status. Authorisation
 * re-reads the account record on every request (middleware/auth.ts) precisely
 * so blocking a user takes effect on their next request instead of whenever
 * their session happens to expire.
 */
export async function clearSessionUser(sessionId: string): Promise<SessionRecord> {
  return withLock(`session:${sessionId}`, async () => {
    const existing =
      (await readJsonFile<SessionRecord>(sessionFile(sessionId))) ?? { sessionId, createdAt: new Date().toISOString() };
    const { userId: _wasUser, loggedInAt: _wasAt, ...rest } = existing;
    await writeJsonFileAtomic(sessionFile(sessionId), rest);
    return rest;
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
 * emptied rather than deleted: clearSessionUser already does exactly this under
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
  // No sessions directory yet means there is nothing to sign out.
  const entries = await readdirOrEmpty(sessionsDir());

  let signedOut = 0;
  for (const sessionId of entries) {
    if (sessionId === keepSessionId) continue;
    const record = await readJsonFile<SessionRecord>(sessionFile(sessionId));
    if (record?.userId !== userId) continue;
    await clearSessionUser(sessionId);
    signedOut += 1;
  }
  return signedOut;
}

/** 로그아웃한 세션 기록은 이만큼 지나면 지운다 — 같은 쿠키로 곧 다시 들어오는 경우만 남긴다. */
const SIGNED_OUT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * 더는 아무 것도 열어 주지 못하는 세션 기록을 지운다: 로그인 시한(sessionMaxAgeHours)이
 * 지난 것과, 로그아웃한 지 하루가 지난 것.
 *
 * 지우는 곳이 없어서 기록이 한 번 로그인할 때마다 하나씩 영영 쌓였고(운영에서 257개),
 * 비밀번호를 바꿀 때의 전수 조사(signOutSessions)가 그만큼 길어졌다. 지워도 달라지는
 * 것은 없다 — 만료된 세션은 이미 로그인으로 인정되지 않고(middleware/auth.ts), 기록이
 * 없는 쿠키는 로그인하지 않은 방문자와 같다.
 */
export async function sweepStaleSessions(maxAgeHours: number, now: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const sessionId of await readdirOrEmpty(sessionsDir())) {
    const record = await readJsonFile<SessionRecord>(sessionFile(sessionId)).catch(() => undefined);
    if (!record) continue;
    const loggedInAt = record.loggedInAt ? Date.parse(record.loggedInAt) : NaN;
    const createdAt = Date.parse(record.createdAt);
    const expired = record.userId
      ? Number.isFinite(loggedInAt) && now - loggedInAt > maxAgeHours * 60 * 60 * 1000
      : Number.isFinite(createdAt) && now - createdAt > SIGNED_OUT_GRACE_MS;
    if (!expired) continue;
    await withLock(`session:${sessionId}`, () => fs.rm(sessionDir(sessionId), { recursive: true, force: true }));
    removed++;
  }
  return removed;
}
