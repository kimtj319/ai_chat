import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getUser } from "../storage/userStore.js";
import type { AuthErrorCode, UserRecord } from "../types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The signed-in account, or undefined on an anonymous request. */
      user?: UserRecord;
      /**
       * Who owns the conversations this request may touch — the account id.
       * Set only when `user` is set, so a route that reads it has already been
       * through requireActiveUser.
       */
      ownerId: string;
    }
  }
}

/**
 * The only /api paths an unauthenticated caller may reach. Everything else —
 * conversations, attachments, models, tools, the session probe, the admin
 * routes — is refused with 401.
 *
 * /health is on the list as a LIVENESS PING, not as an exception to the rule:
 * `./start_web.sh start` polls it for a 200 to decide whether the server came
 * up, and so does the container healthcheck, so gating it would make every
 * deployment report a failed start for a server that is running perfectly. It
 * answers anonymous callers with `{ backend: "ok" }` and nothing else — the
 * endpoint list, the model names and the vLLM reachability breakdown are only
 * returned to a signed-in account (routes/health.ts).
 *
 * Paths are matched against req.path INSIDE the "/api" mount, so they are
 * written without the prefix.
 */
const PUBLIC_API_PATHS = new Set(["/auth/signup", "/auth/login", "/auth/logout", "/auth/me", "/health"]);

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.has(path.replace(/\/+$/, "") || "/");
}

function refuse(res: Response, status: number, code: AuthErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

/**
 * Resolve the session's account, if any, and hang it on the request.
 *
 * The record is read from disk on EVERY request rather than cached in the
 * session: that is what makes "blocked" take effect immediately instead of at
 * session expiry, and it makes a deleted account's session stop working the
 * moment the file is gone. One small JSON read per request is a price worth
 * paying for an authorisation decision that is never stale.
 */
/** A sign-in older than the configured lifetime is no longer a sign-in. */
function sessionExpired(loggedInAt: string | undefined): boolean {
  if (!loggedInAt) return false;
  const at = Date.parse(loggedInAt);
  if (Number.isNaN(at)) return true;
  return Date.now() - at > config.sessionMaxAgeHours * 60 * 60 * 1000;
}

export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.sessionUserId;
    // An expired sign-in is treated as no sign-in at all. The record is left
    // alone; the next login writes a fresh one anyway, and rewriting state
    // from a read path is how a GET ends up racing a write.
    if (userId && !sessionExpired(req.sessionLoggedInAt)) {
      const user = await getUser(userId);
      if (user) {
        req.user = user;
        req.ownerId = user.id;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Refuse anything that is not a public auth path unless the request carries an
 * active account. Mounted before the body parsers so it also covers the raw
 * attachment upload route.
 */
export function requireActiveUser(req: Request, res: Response, next: NextFunction): void {
  if (isPublicApiPath(req.path)) return next();
  const user = req.user;
  if (!user) return refuse(res, 401, "unauthorized", "로그인이 필요합니다.");
  if (user.status === "blocked") {
    // A session that was signed in before the block reaches this on its very
    // next request, because the status was just read from disk.
    return refuse(res, 403, "blocked", "차단된 계정입니다. 관리자에게 문의해 주세요.");
  }
  if (user.status !== "active") {
    return refuse(res, 403, "pending_approval", "관리자 승인 대기 중인 계정입니다.");
  }
  next();
}

/** Admin-only routes. Assumes requireActiveUser already ran. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    return refuse(res, 403, "not_admin", "관리자만 사용할 수 있는 기능입니다.");
  }
  next();
}
