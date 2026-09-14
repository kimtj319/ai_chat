import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { isValidId } from "../storage/paths.js";
import { getOrCreateSession } from "../storage/sessionStore.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId: string;
      sessionCreatedAt: string;
      /**
       * The account this session was signed in as, straight from the session
       * record. Only says who the session *claims* to be — whether that account
       * may do anything is decided in middleware/auth.ts, which re-reads the
       * account itself.
       */
      sessionUserId?: string;
      /** When this session signed in, for the absolute-expiry check. */
      sessionLoggedInAt?: string;
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Writes the session cookie. Exported because login has to rewrite it: the id
 * is replaced on sign-in, and the browser has to be told the new one.
 */
export function setSessionCookie(res: Response, sessionId: string): void {
  const attrs = [
    `${config.sessionCookieName}=${sessionId}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${config.sessionMaxAgeHours * 60 * 60}`,
    "Path=/",
  ];
  if (config.cookieSecure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

/** Ensures every /api request has a valid session, issuing the `sid` cookie on first contact. */
export async function sessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const candidate = cookies[config.sessionCookieName];
    const record = await getOrCreateSession(isValidId(candidate) ? candidate : undefined);
    req.sessionId = record.sessionId;
    req.sessionCreatedAt = record.createdAt;
    req.sessionUserId = record.userId;
    req.sessionLoggedInAt = record.loggedInAt;
    if (candidate !== record.sessionId) setSessionCookie(res, record.sessionId);
    next();
  } catch (err) {
    next(err);
  }
}
