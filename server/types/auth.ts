export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  /**
   * The account this browser session is signed in as. Absent = signed out.
   * Login writes this on a brand-new session id rather than on the one the
   * browser arrived with (storage/sessionStore.ts, signInOnFreshSession).
   */
  userId?: string;
  loggedInAt?: string;
}

/**
 * pending  — registered, waiting for an admin. Cannot sign in.
 * active   — approved. The only status that can sign in.
 * blocked  — approved once, then blocked. Cannot sign in, and any session it
 *            already owns stops working on its very next request (the status is
 *            read from disk per request, never cached).
 */
export type UserStatus = "pending" | "active" | "blocked";
export type UserRole = "user" | "admin";

/**
 * One account, stored at {DATA_DIR}/auth/users/{id}.json.
 * `passwordHash` is the whole self-describing scrypt string (auth/password.ts);
 * the password itself is never stored, never logged and never returned.
 */
export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  /** Who approved/blocked/unblocked last, for the admin list. */
  statusChangedBy?: string;
  statusChangedAt?: string;
  /**
   * The group this account is filed under, or absent for "no group". A plain
   * id rather than a list: one place per account is the whole model. Mostly a
   * folder an admin sorts accounts into — but not only: a group whose NAME is
   * in PRIVILEGED_GROUPS gives its members the shared keys and every model
   * (auth/privilege.ts).
   */
  groupId?: string;
}

/**
 * One group: a name an admin can file accounts under. The name is not only a
 * label — auth/privilege.ts grants the shared keys and every model to members
 * of a group named in PRIVILEGED_GROUPS.
 */
export interface GroupRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** What the API returns about an account — everything except the hash. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
  statusChangedBy?: string;
  statusChangedAt?: string;
  groupId?: string;
}

export function toPublicUser(user: UserRecord): PublicUser {
  const { passwordHash: _never, updatedAt: _unused, ...rest } = user;
  return rest;
}

/**
 * Machine-readable reason on every auth refusal, so the UI picks its own Korean
 * wording instead of matching on prose. `invalid_credentials` is deliberately
 * returned for both a wrong password and an unknown id — see routes/auth.ts.
 */
export type AuthErrorCode =
  | "invalid_credentials"
  | "pending_approval"
  | "blocked"
  | "duplicate_id"
  | "weak_password"
  // The new password is the one already in use, so the change would be a no-op.
  | "same_password"
  | "invalid_input"
  // 401. Named for the HTTP status, and matching the literal the frontend's
  // own AuthErrorCode union was built against (src/api/types.ts).
  | "unauthorized"
  | "not_admin"
  | "not_found"
  | "rate_limited"
  | "cannot_block_self"
  // Deleting your own account would lock the deployment out of its own
  // administration, and is the only guard needed: an admin cannot be the last
  // one AND be deleted by someone else at the same time.
  | "cannot_delete_self"
  | "duplicate_group";
