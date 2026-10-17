import type { Request } from "express";

/**
 * In-memory token buckets, refilled continuously: `capacity` tokens per
 * `windowMs`, one spent per call. In memory on purpose — they protect this
 * process's disk, CPU and accounts, and a restart losing the counters is not a
 * security property anyone should be relying on.
 *
 * Returns `take(key, capacity)`, true when the call may go ahead. One instance
 * per limiter; the key decides what is being counted (an account, an address).
 */
export function createTokenBucket(windowMs: number): (key: string, capacity: number) => boolean {
  const buckets = new Map<string, { tokens: number; last: number }>();
  return (key, capacity) => {
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: capacity, last: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / windowMs) * capacity);
    bucket.last = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    buckets.set(key, bucket);
    // Keys only grow, so a full bucket that has not been touched in five
    // windows is dropped rather than kept forever.
    if (buckets.size > 1000) {
      for (const [existing, value] of buckets) {
        if (now - value.last > 5 * windowMs) buckets.delete(existing);
      }
    }
    return allowed;
  };
}

/** The caller's address, for rate-limit keys and for the log lines that say who did something. */
export function clientAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}
