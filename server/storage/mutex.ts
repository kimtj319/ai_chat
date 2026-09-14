// Simple in-process per-key mutex implemented as a chain of promises. Used to
// serialise reads-modify-writes of the same conversation file so concurrent
// requests can't interleave their writes.

const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(fn);
  const guarded = run.catch(() => undefined);
  chains.set(key, guarded);
  guarded.finally(() => {
    if (chains.get(key) === guarded) chains.delete(key);
  });
  return run;
}
