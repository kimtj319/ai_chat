import crypto from "node:crypto";

/**
 * Password hashing with node:crypto scrypt. No new dependency (no bcrypt, no
 * argon2 native build), and scrypt is the memory-hard KDF Node ships.
 *
 * Parameters: N=2^15, r=8, p=1, 32-byte salt, 64-byte key.
 *   - N=32768/r=8 is scrypt's "interactive login" setting and costs
 *     128 * N * r = 32 MiB of memory per hash. That is the whole point: a GPU
 *     attacker cannot run thousands of these in parallel the way it can with a
 *     plain SHA. Measured on this machine at the bottom of this file's test
 *     (scripts/verify-auth.ts): ~60-90 ms per hash, which is unnoticeable on a
 *     login and ruinous for a brute-force run.
 *   - maxmem must be raised explicitly: Node's default cap is 32 MiB and the
 *     memory this costs is 32 MiB *plus* scrypt's own overhead, so the call
 *     throws "Invalid scrypt params" with the default. 64 MiB leaves headroom.
 *   - The salt is per user and random, so two accounts with the same password
 *     get different hashes and one cracked hash says nothing about the other.
 *
 * Stored format is self-describing — `scrypt$N$r$p$saltB64$hashB64` — so the
 * parameters can be raised later and old hashes still verify with the ones they
 * were made with (and can be re-hashed on the next successful login if that day
 * comes).
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 32;
const MAXMEM = 64 * 1024 * 1024;

/**
 * Minimum password length. Eight is the floor that a login rate limit
 * (routes/auth.ts) plus a 32 MiB-per-guess KDF makes defensible; anything
 * shorter is guessable however slow the hash is.
 */
export const MIN_PASSWORD_LENGTH = 8;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N: n, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** True when this string is acceptable as a password at all. */
export function isStrongEnough(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Constant-time verification. Every failure path returns false rather than
 * throwing, so a corrupt stored hash cannot be told apart from a wrong
 * password by the caller (or by anyone timing it).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p, expected.length);
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // side channel; the lengths are equal by construction above, and the guard
  // keeps that true if the stored format is ever tampered with.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
