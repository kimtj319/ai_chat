/**
 * Keeps thinking that spills past a thinking_token_budget cut out of the answer.
 *
 * vLLM enforces thinking_token_budget (chat/reasoningProfiles.ts, levels low and
 * medium) by ending the think block at that token count, mid-sentence if need
 * be. Usually the model then writes its answer, but sometimes it keeps thinking
 * in the answer channel: in production (2026-09-16) the reasoning stopped at "Should I
 * also add `top" and the answer opened with "` etc. for the small model?" and
 * 3,000 more characters of English deliberation, code blocks included, before
 * the Korean answer began. On screen that is the thinking text jumping out of
 * the thinking panel.
 *
 * The gate only acts when the cut is visible and the languages tell the two
 * apart: reasoning that ends mid-sentence, reasoning in another script than the
 * question (Qwen thinks in English for a Korean question), and a question with
 * Hangul in it. Then the answer is held back paragraph by paragraph: paragraphs
 * without Hangul are the thought running on and go to reasoning; the first
 * paragraph with Hangul is where the answer starts, and from there on every
 * delta passes straight through. In every other case it passes everything
 * through from the first delta, exactly as before.
 */

const HANGUL = /[ㄱ-ㆎ가-힣]/g;
const LETTER = /[\p{L}]/gu;
/** A paragraph is the answer once this share of its letters is Hangul. */
const ANSWER_HANGUL_SHARE = 0.3;
/** Reasoning below this share of Hangul is "in another script" than a Korean question. */
const REASONING_HANGUL_SHARE = 0.1;
/** Held back at most this much; past it the rest is let through as the answer. */
const MAX_HELD_CHARS = 20_000;

function hangulShare(text: string): number {
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(HANGUL)?.length ?? 0) / letters;
}

/** Did the thinking stop mid-sentence (the budget cut it) rather than at an end? */
export function looksCut(reasoning: string): boolean {
  const tail = reasoning.trimEnd();
  if (tail.length === 0) return false;
  return !/[.!?。…:)\]"'”’`*]$/.test(tail);
}

export class BudgetLeakGate {
  private mode: "pass" | "hold";
  private held = "";
  private heldTotal = 0;

  constructor(options: { budgetSet: boolean; reasoning: string; question: string }) {
    const applies =
      options.budgetSet &&
      looksCut(options.reasoning) &&
      hangulShare(options.question) >= ANSWER_HANGUL_SHARE &&
      hangulShare(options.reasoning) < REASONING_HANGUL_SHARE;
    this.mode = applies ? "hold" : "pass";
  }

  /** Whether it is still deciding (for logging). */
  get holding(): boolean {
    return this.mode === "hold";
  }

  /** One content delta in; what belongs to each channel out. */
  feed(delta: string): { reasoning: string; content: string } {
    if (this.mode === "pass") return { reasoning: "", content: delta };
    this.held += delta;
    this.heldTotal += delta.length;
    return this.drain(false);
  }

  /** The stream ended: decide whatever is still held. */
  end(): { reasoning: string; content: string } {
    if (this.mode === "pass") return { reasoning: "", content: "" };
    return this.drain(true);
  }

  private drain(final: boolean): { reasoning: string; content: string } {
    let reasoning = "";
    for (;;) {
      const cut = this.paragraphEnd();
      if (cut === -1) break;
      const paragraph = this.held.slice(0, cut);
      if (hangulShare(paragraph) >= ANSWER_HANGUL_SHARE) return this.release(reasoning);
      reasoning += paragraph;
      this.held = this.held.slice(cut);
    }
    if (final || this.heldTotal > MAX_HELD_CHARS) {
      // The last, unterminated paragraph: the answer if it reads as one,
      // otherwise thought that never reached an answer (the empty-answer
      // wrap-up in toolLoop then writes one from the reasoning).
      if (this.heldTotal > MAX_HELD_CHARS || hangulShare(this.held) >= ANSWER_HANGUL_SHARE) return this.release(reasoning);
      reasoning += this.held;
      this.held = "";
    }
    return { reasoning, content: "" };
  }

  private release(reasoning: string): { reasoning: string; content: string } {
    this.mode = "pass";
    const content = this.held.replace(/^\s+/, "");
    this.held = "";
    return { reasoning, content };
  }

  /**
   * End (exclusive, separator included) of the first complete paragraph, or -1.
   * A fenced code block is never split, so a ``` block inside the spilled
   * thought travels with it as one paragraph.
   */
  private paragraphEnd(): number {
    let inFence = false;
    for (let i = 0; i < this.held.length; i++) {
      if (this.held.startsWith("```", i) && (i === 0 || this.held[i - 1] === "\n")) {
        inFence = !inFence;
        i += 2;
        continue;
      }
      if (!inFence && this.held.startsWith("\n\n", i)) {
        let end = i + 2;
        while (this.held[end] === "\n") end++;
        // A paragraph of only whitespace is not a decision; keep reading.
        if (this.held.slice(0, i).trim().length === 0) continue;
        return end;
      }
    }
    return -1;
  }
}
