/**
 * Stops a model that has fallen into repeating the same text without ever
 * emitting its end token.
 *
 * Seen on DeepSeek V4.1 Flash (production, 2026-11-05): the stream kept writing
 * the same span until max_tokens, and the person had to press Stop after a
 * minute. Penalties do not fix it on that server (measured 2026-11-06 with
 * synthetic prompts): repetition_penalty 1.1 still ran to `length`, and 2.0 or
 * frequency_penalty 2.0 broke an ordinary numbered list. So the stream itself is
 * watched instead, the same way for every model.
 *
 * A trip needs the tail of the channel to be EXACTLY periodic: one span of at
 * most MAX_PERIOD characters, repeated at least MIN_REPEATS times and covering
 * at least MIN_SPAN characters. A table or a list varies from row to row, so it
 * never matches; a loop repeats byte for byte, so it does.
 */

/** Total characters the repeated tail must cover before it counts. */
const MIN_SPAN = 2000;
/** Times the span must occur back to back. */
const MIN_REPEATS = 6;
/** Longest span looked for: a repeated paragraph, not just a repeated word. */
const MAX_PERIOD = 1500;
/** Characters of the channel kept for the check — enough for MIN_REPEATS of MAX_PERIOD. */
const WINDOW = MAX_PERIOD * MIN_REPEATS + MIN_SPAN;
/** New characters between two checks, so a stream of one-character deltas is not checked per character. */
const CHECK_EVERY = 64;

export interface RepetitionTrip {
  /** Length of the repeated span. */
  period: number;
  /** How many times it occurs back to back (fractional when the last copy is partial). */
  repeats: number;
  /** Characters to cut from the end of the channel so that exactly one copy remains. */
  drop: number;
}

/**
 * The shortest period the tail of `text` repeats with, if the repetition is long
 * enough to count. Exported for the tests.
 */
export function findTailRepetition(text: string): RepetitionTrip | null {
  const end = text.length - 1;
  const maxPeriod = Math.min(MAX_PERIOD, Math.floor(text.length / 2));
  for (let period = 1; period <= maxPeriod; period++) {
    // Count matching characters backwards: text[i] === text[i + period].
    let i = end - period;
    while (i >= 0 && text.charCodeAt(i) === text.charCodeAt(i + period)) i--;
    const span = end - i;
    if (span >= MIN_SPAN && span >= period * MIN_REPEATS) {
      return { period, repeats: span / period, drop: span - period };
    }
  }
  return null;
}

/** One per channel per model call: reasoning and answer are watched separately. */
export class RepetitionGuard {
  private window = "";
  private sinceCheck = 0;
  private tripped = false;

  /**
   * Feed the text just appended to the channel. Returns the trip once, at the
   * first check that finds a long enough repetition; null otherwise. `drop` never
   * exceeds what was fed to this guard.
   */
  feed(delta: string): RepetitionTrip | null {
    if (this.tripped || delta.length === 0) return null;
    this.window += delta;
    if (this.window.length > WINDOW) this.window = this.window.slice(-WINDOW);
    this.sinceCheck += delta.length;
    if (this.sinceCheck < CHECK_EVERY) return null;
    this.sinceCheck = 0;
    const trip = findTailRepetition(this.window);
    if (trip) this.tripped = true;
    return trip;
  }
}
