import { config } from "../config.js";
import { MIN_PASSWORD_LENGTH } from "./password.js";
import { createUser, getUser, listUsers, normalizeEmail, normalizeName, normalizeUserId } from "../storage/userStore.js";

/**
 * The first admin, from the environment.
 *
 * Every account except this one is created pending and approved by an admin —
 * so without this there is no one to do the approving and the deployment is
 * bricked. It runs at startup, creates the account only when ADMIN_ID names one
 * that does not exist yet, and never touches an existing account (so changing
 * ADMIN_PASSWORD later does not silently reset a password an admin has already
 * chosen — say so rather than pretending to).
 *
 * There is deliberately NO default password: an app that ships one is an app
 * with a known-password admin on every deployment that forgot to change it.
 * A missing or too-short one is refused, loudly, with the reason — being locked
 * out while the log says nothing is the failure mode this exists to avoid.
 */
export async function ensureAdminFromEnv(): Promise<void> {
  const id = normalizeUserId(config.adminId);
  const hasAnyAdmin = (await listUsers()).some((user) => user.role === "admin");

  if (!config.adminId) {
    if (!hasAnyAdmin) {
      console.warn(
        "[auth] no admin account exists and ADMIN_ID is not set. Nobody can approve signups. " +
          "Set ADMIN_ID, ADMIN_PASSWORD, ADMIN_NAME and ADMIN_EMAIL and restart.",
      );
    }
    return;
  }
  if (!id) {
    console.error(`[auth] ADMIN_ID="${config.adminId}" is not a valid id (3-32 of a-z, 0-9, '-', '_'); no admin was created.`);
    return;
  }
  if (await getUser(id)) {
    // Already there. Not touched on purpose — see above.
    console.log(`[auth] admin "${id}" already exists; ADMIN_PASSWORD is ignored for an existing account.`);
    return;
  }
  if (config.adminPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `[auth] refusing to create admin "${id}": ADMIN_PASSWORD is ${config.adminPassword.length === 0 ? "not set" : `only ${config.adminPassword.length} characters`}, ` +
        `and at least ${MIN_PASSWORD_LENGTH} are required. No admin account was created.`,
    );
    return;
  }

  const name = normalizeName(config.adminName) ?? id;
  const email = normalizeEmail(config.adminEmail) ?? `${id}@localhost`;
  const created = await createUser({ id, name, email, password: config.adminPassword, status: "active", role: "admin" });
  if (!created.ok) {
    // Lost a race with another process against the same DATA_DIR.
    console.warn(`[auth] admin "${id}" was created by someone else while starting up; leaving it alone.`);
    return;
  }
  console.log(`[auth] created admin account "${id}" (${email}) from ADMIN_ID/ADMIN_PASSWORD — sign in and approve pending signups.`);
}
