/**
 * Context compaction as the page sees it: progress events on the turn's own
 * stream, and a per-conversation record of a compaction still running.
 *
 * The record is what lets a page that was reloaded or reopened mid-compaction
 * show the same bar and keep the composer locked (GET
 * /conversations/:id/compaction), and what the route consults before tearing a
 * turn down because its client went away: a compaction is allowed to finish so
 * that the summary it is writing is saved (routes/conversations.ts).
 */

/** "history": earlier turns folded into the stored summary. "research": this turn's tool results. */
export type CompactionKind = "history" | "research";

export interface CompactionEvent {
  type: "compaction";
  kind: CompactionKind;
  phase: "start" | "progress" | "end";
  /** 0..1. */
  progress: number;
  /** On "end": whether the context was actually compacted. */
  ok?: boolean;
}

export interface CompactionStatus {
  kind: CompactionKind;
  progress: number;
  startedAt: string;
}

interface Running extends CompactionStatus {
  ownerId: string;
  settled: Promise<void>;
  settle: () => void;
}

const running = new Map<string, Running>();

/** The compaction running for this account's conversation, if any. */
export function compactionStatus(ownerId: string, conversationId: string): CompactionStatus | null {
  const entry = running.get(conversationId);
  if (!entry || entry.ownerId !== ownerId) return null;
  return { kind: entry.kind, progress: entry.progress, startedAt: entry.startedAt };
}

/** Resolves when the conversation's running compaction ends; null when none is running. */
export function compactionSettled(conversationId: string): Promise<void> | null {
  return running.get(conversationId)?.settled ?? null;
}

/** Fewer events than deltas: one per 2% or 300ms is smooth enough for a bar. */
const MIN_STEP = 0.02;
const MIN_INTERVAL_MS = 300;

/**
 * Runs `work`, yielding compaction events while it does, and returns its value.
 *
 * Nothing is yielded unless `work` calls `report` — most turns measure, find
 * the window roomy, and never start a model call, and they must not flash a bar.
 * The first report (normally 0, when the summarisation call starts) yields
 * "start" and registers the conversation as compacting; the end always yields
 * "end", with `ok` from `succeeded`.
 */
export async function* withCompactionEvents<T>(
  target: { ownerId: string; conversationId: string; kind: CompactionKind },
  work: (report: (fraction: number) => void) => Promise<T>,
  succeeded: (value: T) => boolean,
): AsyncGenerator<CompactionEvent, T> {
  const queue: CompactionEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (event: CompactionEvent) => {
    queue.push(event);
    wake?.();
  };

  let entry: Running | null = null;
  let lastProgress = -1;
  let lastAt = 0;
  const report = (fraction: number) => {
    const progress = Math.max(0, Math.min(1, fraction));
    if (!entry) {
      let settle = () => {};
      const settled = new Promise<void>((resolve) => (settle = resolve));
      entry = { ownerId: target.ownerId, kind: target.kind, progress, startedAt: new Date().toISOString(), settled, settle };
      // A second compaction in the same turn replaces the first's record.
      running.get(target.conversationId)?.settle();
      running.set(target.conversationId, entry);
      lastProgress = progress;
      lastAt = Date.now();
      push({ type: "compaction", kind: target.kind, phase: "start", progress });
      return;
    }
    entry.progress = progress;
    if (progress - lastProgress < MIN_STEP && Date.now() - lastAt < MIN_INTERVAL_MS) return;
    lastProgress = progress;
    lastAt = Date.now();
    push({ type: "compaction", kind: target.kind, phase: "progress", progress });
  };

  let finished = false;
  let value: T | undefined;
  let failure: unknown;
  let failed = false;
  void work(report).then(
    (result) => {
      value = result;
      finished = true;
      wake?.();
    },
    (err) => {
      failure = err;
      failed = true;
      finished = true;
      wake?.();
    },
  );

  try {
    while (!finished || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      // No await between the checks above and this one, so a push or a finish
      // cannot slip in unseen.
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  } finally {
    const started = entry as Running | null;
    if (started) {
      if (running.get(target.conversationId) === started) running.delete(target.conversationId);
      started.settle();
    }
  }
  if (entry) {
    yield {
      type: "compaction",
      kind: target.kind,
      phase: "end",
      progress: 1,
      ok: !failed && succeeded(value as T),
    };
  }
  if (failed) throw failure;
  return value as T;
}
