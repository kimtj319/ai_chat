import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import crypto from "node:crypto";
import { hashPassword, isStrongEnough, MIN_PASSWORD_LENGTH, verifyPassword } from "../auth/password.js";
import {
  createUser,
  getUser,
  normalizeEmail,
  normalizeName,
  normalizeUserId,
  setUserPassword,
} from "../storage/userStore.js";
import { setSessionUser, signInOnFreshSession, signOutOtherSessions } from "../storage/sessionStore.js";
import { setSessionCookie } from "../middleware/session.js";
import { toPublicUser } from "../types.js";
import type { AuthErrorCode } from "../types.js";

export const authRouter = Router();

function fail(res: Response, status: number, code: AuthErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

/**
 * Login rate limiting: the same in-memory token bucket the upload route uses,
 * with two independent buckets.
 *
 * A local account store is trivially brute-forcible otherwise: nothing else
 * here costs an attacker anything per guess except the KDF, and a KDF only
 * multiplies the cost, it does not bound the number of attempts. In memory on
 * purpose, exactly as for uploads — it protects this process, and a restart
 * losing the counters is not a security property anyone should be relying on.
 *
 * The id bucket is keyed on the NORMALISED id, so trying "Alice" and "alice"
 * spends one bucket rather than two.
 */
const RATE_WINDOW_MS = 60_000;
const buckets = new Map<string, { tokens: number; last: number }>();

function takeToken(key: string, capacity: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: capacity, last: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / RATE_WINDOW_MS) * capacity);
  bucket.last = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  buckets.set(key, bucket);
  if (buckets.size > 1000) {
    for (const [existing, value] of buckets) {
      if (now - value.last > 5 * RATE_WINDOW_MS) buckets.delete(existing);
    }
  }
  return allowed;
}

/** Test seam: the verification script needs a clean slate between cases. */
export function resetLoginRateLimit(): void {
  buckets.clear();
}

function clientAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * POST /api/auth/signup — register. The account starts `pending` and cannot
 * sign in until an admin approves it.
 */
authRouter.post("/auth/signup", async (req, res, next) => {
  try {
    // Signup is reachable without a session, so without this one caller can
    // fill the admin's approval queue from a script.
    if (!takeToken(`signup:${clientAddress(req)}`, config.loginAttemptsPerMinutePerIp)) {
      return fail(res, 429, "rate_limited", "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.");
    }
    const body = req.body ?? {};
    const id = normalizeUserId(body.id);
    const name = normalizeName(body.name);
    const email = normalizeEmail(body.email);
    if (!id) {
      return fail(res, 400, "invalid_input", "아이디는 영문 소문자·숫자·-·_ 를 3~32자로 입력해 주세요.");
    }
    if (!name) return fail(res, 400, "invalid_input", "이름을 입력해 주세요 (최대 60자).");
    if (!email) return fail(res, 400, "invalid_input", "이메일 주소를 정확히 입력해 주세요.");
    if (!isStrongEnough(body.password)) {
      return fail(res, 400, "weak_password", `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    }

    const created = await createUser({ id, name, email, password: body.password });
    if (!created.ok) {
      // Signup is the one place an id's existence is necessarily revealed — the
      // alternative is telling the user their account was created when it was
      // not. Login says nothing (see below).
      return fail(res, 409, "duplicate_id", "이미 사용 중인 아이디입니다.");
    }
    console.log(`[auth] signup ${created.user.id} (${created.user.email}) from ${clientAddress(req)} — pending approval`);
    res.status(201).json({ user: toPublicUser(created.user), code: "pending_approval" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login.
 *
 * An unknown id and a wrong password return the SAME 401 with the same
 * `invalid_credentials` code and the same message. Distinguishing them would
 * turn this endpoint into an account-name oracle. The password is verified even
 * for an unknown id — against a throwaway hash — so the two paths also cost the
 * same amount of time.
 *
 * `pending_approval` and `blocked` ARE distinguished: those are states the
 * person already knows they are in (they registered, or an admin told them),
 * and answering "wrong password" to someone whose account is merely awaiting
 * approval sends them to reset a password that is perfectly correct.
 */
authRouter.post("/auth/login", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = normalizeUserId(body.id);
    const password = typeof body.password === "string" ? body.password : "";
    const ip = clientAddress(req);

    if (!takeToken(`ip:${ip}`, config.loginAttemptsPerMinutePerIp)) {
      console.warn(`[auth] login rate limit hit for address ${ip}`);
      return fail(res, 429, "rate_limited", "로그인 시도가 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
    }
    if (id && !takeToken(`id:${id}`, config.loginAttemptsPerMinutePerId)) {
      console.warn(`[auth] login rate limit hit for id ${id} (from ${ip})`);
      return fail(res, 429, "rate_limited", "로그인 시도가 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
    }

    const user = id ? await getUser(id) : null;
    // Always run the KDF, even when there is no such account, so "unknown id"
    // and "wrong password" take the same time as well as saying the same thing.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));
    if (!user || !ok) {
      return fail(res, 401, "invalid_credentials", "아이디 또는 비밀번호가 올바르지 않습니다.");
    }
    if (user.status === "pending") {
      return fail(res, 403, "pending_approval", "관리자 승인 대기 중인 계정입니다. 승인 후 로그인할 수 있습니다.");
    }
    if (user.status === "blocked") {
      return fail(res, 403, "blocked", "차단된 계정입니다. 관리자에게 문의해 주세요.");
    }

    // A new id, and the browser is told about it: see signInOnFreshSession.
    const session = await signInOnFreshSession(req.sessionId, user.id);
    req.sessionId = session.sessionId;
    setSessionCookie(res, session.sessionId);
    console.log(`[auth] login ${user.id} from ${ip}`);
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

/**
 * A real scrypt hash of a random string, made once on the first login attempt.
 * Verifying against it costs exactly what verifying a real account costs, which
 * is the point: without it an unknown id would answer measurably faster than a
 * known one, and "never reveal whether an id exists" would only hold for
 * someone who is not holding a stopwatch.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomUUID());
  return dummyHashPromise;
}

/** POST /api/auth/logout — always 204, whether or not anyone was signed in. */
authRouter.post("/auth/logout", async (req, res, next) => {
  try {
    if (req.sessionUserId) {
      await setSessionUser(req.sessionId, null);
      console.log(`[auth] logout ${req.sessionUserId}`);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/password — change your own password.
 *
 * This path is deliberately NOT in PUBLIC_API_PATHS, so requireActiveUser has
 * already refused anyone who is not signed in and active before the handler
 * runs, and `req.user` is the account doing the changing. Nobody can aim this
 * at another account: the id is taken from the session, never from the body.
 *
 * The current password is demanded again even though the session is already
 * authenticated. That is what stops someone who finds an unlocked browser from
 * locking the owner out of their own account in one click.
 */
authRouter.post("/auth/password", async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) return fail(res, 401, "unauthorized", "로그인이 필요합니다.");
    // Without this, whoever holds a session can grind the current password.
    if (!takeToken(`password:${user.id}`, config.loginAttemptsPerMinutePerId)) {
      return fail(res, 429, "rate_limited", "요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.");
    }

    const body = req.body ?? {};
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (currentPassword.length === 0 || newPassword.length === 0) {
      return fail(res, 400, "invalid_input", "현재 비밀번호와 새 비밀번호를 모두 입력해주세요.");
    }

    // 403 rather than 401: the session is perfectly valid, it is this one
    // credential that did not match. A 401 here would read as "your session
    // died" and send the app back to the login screen.
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return fail(res, 403, "invalid_credentials", "현재 비밀번호가 올바르지 않습니다.");
    }
    if (!isStrongEnough(newPassword)) {
      return fail(res, 400, "weak_password", `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    }
    if (newPassword === currentPassword) {
      return fail(res, 400, "same_password", "현재 사용 중인 비밀번호와 다른 비밀번호를 입력해주세요.");
    }

    const updated = await setUserPassword(user.id, await hashPassword(newPassword));
    if (!updated) return fail(res, 404, "not_found", "계정을 찾을 수 없습니다.");

    const signedOut = await signOutOtherSessions(user.id, req.sessionId);
    console.log(`[auth] password changed for ${user.id}; other sessions signed out: ${signedOut}`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me — who this browser is signed in as.
 *
 * Public only in the sense that it is reachable while signed out, where it
 * answers 401: it is how the SPA decides whether to show the login page.
 * A pending or blocked account gets its own code here too, so a session that
 * was signed in when the block landed is told why it stopped working.
 */
authRouter.get("/auth/me", (req, res) => {
  const user = req.user;
  if (!user) return fail(res, 401, "unauthorized", "로그인이 필요합니다.");
  if (user.status === "blocked") return fail(res, 403, "blocked", "차단된 계정입니다. 관리자에게 문의해 주세요.");
  if (user.status !== "active") return fail(res, 403, "pending_approval", "관리자 승인 대기 중인 계정입니다.");
  res.json({ user: toPublicUser(user) });
});
