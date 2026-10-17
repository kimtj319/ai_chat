/**
 * Abort controllers of the turns currently running, grouped by conversation.
 *
 * A set per conversation, not one controller: two turns can be live on one
 * conversation (two tabs on the same chat), and with a single slot the second
 * overwrote the first — measured, Stop reached only the newer one while the
 * older ran to 6,325 characters, and a second Stop answered "no active stream"
 * while it was still going.
 */
export class TurnSignals {
  private readonly live = new Map<string, Set<AbortController>>();

  track(conversationId: string, controller: AbortController): void {
    const set = this.live.get(conversationId) ?? new Set<AbortController>();
    set.add(controller);
    this.live.set(conversationId, set);
  }

  /** Removes only this turn's controller, so a finished turn never frees another's slot. */
  untrack(conversationId: string, controller: AbortController): void {
    const set = this.live.get(conversationId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.live.delete(conversationId);
  }

  /** Whether any turn is live on the conversation — or, given a controller, whether that one still is. */
  has(conversationId: string, controller?: AbortController): boolean {
    const set = this.live.get(conversationId);
    if (!set) return false;
    return controller ? set.has(controller) : set.size > 0;
  }

  /** Abort every turn on the conversation. False when none was running. */
  abortAll(conversationId: string): boolean {
    const set = this.live.get(conversationId);
    if (!set || set.size === 0) return false;
    for (const controller of set) controller.abort();
    return true;
  }
}

/**
 * Every turn currently streaming, so DELETE .../stream (Stop) can abort the
 * in-flight vLLM call. Aborting one of these tears the whole SSE response down,
 * and Stop abandons every turn on the conversation, which is what the button
 * says it does.
 */
export const activeStreams = new TurnSignals();

/**
 * Every turn's "지금 답변하기" (answer now) signal, tracked separately from
 * `activeStreams`: aborting one of those tears the whole SSE response down
 * (Stop), which is not what this button does. This holds a SEPARATE
 * AbortController per turn — passed into runConversationTurn as
 * `answerNowSignal` — so triggering it only cuts the current model call short
 * and moves the turn to a wrap-up answer; the response keeps streaming.
 */
export const activeAnswerNowSignals = new TurnSignals();
