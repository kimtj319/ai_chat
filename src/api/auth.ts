import { errorMessage } from "../state/friendlyError";
import { apiPath } from "./base";
import { ApiError, notifyUnauthorized, readErrorBody } from "./http";
import type { AdminGroup, AdminUser, AuthErrorCode, AuthUser, SignupRequest } from "./types";

/** An auth/admin refusal, carrying the server's own `code`. */
export class AuthError extends ApiError {
  readonly code: AuthErrorCode | null;
  readonly status: number;

  constructor(message: string, code: AuthErrorCode | null, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---- Authentication & accounts ----
//
// These use their own fetch helper rather than `request()` for two reasons: on
// the public auth paths a 401 is an ordinary answer ("not signed in", a wrong
// password) rather than a session that just died, so it must not fire the
// global unauthorized handler and loop; and the refusal body carries a `code`
// the screens turn into Korean copy. The admin and password routes are not
// public, so their 401 does mean the session died and bounces like any other.

/** The same set as the server's PUBLIC_API_PATHS (server/middleware/auth.ts). */
const PUBLIC_AUTH_PATHS = new Set(["/auth/login", "/auth/me", "/auth/signup", "/auth/logout"]);

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiPath(path), {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (error) {
    throw new AuthError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`, null, 0);
  }

  if (!response.ok) {
    if (response.status === 401 && !PUBLIC_AUTH_PATHS.has(path)) notifyUnauthorized();
    const body = await readErrorBody(response);
    // Not JSON — the status line is all we have.
    throw new AuthError(body.error ?? `요청이 실패했습니다 (${response.status})`, body.code as AuthErrorCode | null, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The signed-in account, or null when there is no (usable) session. */
export async function getMe(): Promise<AuthUser | null> {
  try {
    // The route answers `{ user }`, the same envelope /auth/login and
    // /auth/signup use. Reading the body as the user itself leaves `status`
    // undefined, which the caller reads as "not signed in".
    const { user } = await authRequest<{ user: AuthUser }>("/auth/me");
    return user;
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Sign in, then read the account back. The contract only promises "200 +
 * session" for the login call itself, so who we are is asked for separately
 * rather than guessed from the login response body.
 *
 * The password is passed straight through to the request and never stored,
 * cached or logged here.
 */
export async function login(id: string, password: string): Promise<AuthUser> {
  await authRequest<unknown>("/auth/login", { method: "POST", body: JSON.stringify({ id, password }) });
  const me = await getMe();
  if (!me) throw new AuthError("로그인 상태를 확인하지 못했습니다.", null, 0);
  return me;
}

/** Request an account. It is created PENDING and cannot sign in yet. */
export async function signup(body: SignupRequest): Promise<void> {
  await authRequest<void>("/auth/signup", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Replace your own password. The account is taken from the session, so this can
 * only ever change the signed-in user's own password.
 *
 * Succeeding signs every OTHER browser of this account out; this one stays in,
 * so there is nothing to do with the session afterwards.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await authRequest<void>("/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function logout(): Promise<void> {
  await authRequest<void>("/auth/logout", { method: "POST" });
}

export function listAdminUsers(): Promise<AdminUser[]> {
  return authRequest<AdminUser[]>("/admin/users");
}

export type AdminUserAction = "approve" | "block" | "unblock";

/**
 * Remove an account and everything it owns. Irreversible — the caller is
 * responsible for having asked first.
 */
export async function deleteAdminUser(id: string): Promise<void> {
  await authRequest<void>(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listAdminGroups(): Promise<AdminGroup[]> {
  return authRequest<AdminGroup[]>("/admin/groups");
}

export function createAdminGroup(name: string): Promise<AdminGroup> {
  return authRequest<AdminGroup>("/admin/groups", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameAdminGroup(id: string, name: string): Promise<AdminGroup> {
  return authRequest<AdminGroup>(`/admin/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteAdminGroup(id: string): Promise<void> {
  await authRequest<void>(`/admin/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `null` takes the account out of whatever group it was in. */
export async function setAdminUserGroup(id: string, groupId: string | null): Promise<void> {
  await authRequest<unknown>(`/admin/users/${encodeURIComponent(id)}/group`, {
    method: "PUT",
    body: JSON.stringify({ groupId }),
  });
}

export async function updateUserStatus(id: string, action: AdminUserAction): Promise<void> {
  await authRequest<void>(`/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}
