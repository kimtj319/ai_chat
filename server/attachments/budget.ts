import { config } from "../config.js";

/**
 * What an attachment costs the prompt, and how much of the prompt attachments
 * may take.
 *
 * Two independent limit families live in this feature, and they must not be
 * collapsed into one:
 *
 *   - Token limits (this file) exist because the prompt has a context window.
 *     They use the measured cost model — clamp(round(w*h/1000), 66, 16386) for
 *     an image, ceil(chars / 2) for inlined text.
 *   - Byte and pixel limits (config + attachments/sniff.ts) exist because bytes
 *     are upload time, disk and base64 latency. The server rescales any image
 *     down to at most 16,386 tokens however large it is, so an 8000x6000 PNG is
 *     a payload problem, not a token problem — a single limit cannot express
 *     both.
 */

/**
 * Pessimistic characters-per-token for inlined text. The real ratio spans ~1.5
 * for dense Korean prose to ~4 for English, and the direction of the error
 * matters: over-charging refuses an upload the window would have held, while
 * under-charging lets a message through that the model then cannot answer.
 */
const TEXT_CHARS_PER_TOKEN = 2;

/**
 * Characters of a non-inlined attachment that still reach the prompt, as the
 * stub's preview (chat/historyBuilder.ts), plus the label, the id and the
 * read_attachment pointer around it.
 */
export const STUB_PREVIEW_CHARS = 400;
const STUB_OVERHEAD_TOKENS = 64;

/** What one text attachment costs the prompt, inlined whole or as a stub. */
export function textPromptTokens(chars: number, inlined: boolean): number {
  if (inlined) return Math.ceil(chars / TEXT_CHARS_PER_TOKEN);
  return Math.ceil(Math.min(chars, STUB_PREVIEW_CHARS) / TEXT_CHARS_PER_TOKEN) + STUB_OVERHEAD_TOKENS;
}

export interface AttachmentBudget {
  /** The window the budget was derived from; null when the model reported none. */
  contextWindow: number | null;
  /** Tokens every attachment of one message may cost together. */
  messageTokens: number;
  /**
   * Tokens one attachment may cost on its own — half the message budget, so a
   * single file can never make a message unanswerable by itself. Checked at
   * upload, where the user can still choose a smaller file.
   */
  singleFileTokens: number;
  /** True when the model reported no window and the configured default was used. */
  fallback: boolean;
}

/**
 * The attachment budget for one conversation's model. Derived from the window
 * that model actually reports (resolveModel/the /models catalog), not from a
 * constant: a conversation on a 32k model must not be allowed the 65,536 tokens
 * a 262,144-token model affords.
 */
export function attachmentBudget(maxModelLen: number | null): AttachmentBudget {
  const messageTokens =
    maxModelLen === null
      ? config.attachmentDefaultMessageTokens
      : Math.floor(maxModelLen * config.attachmentMessageTokenRatio);
  return {
    contextWindow: maxModelLen,
    messageTokens,
    singleFileTokens: Math.floor(messageTokens / 2),
    fallback: maxModelLen === null,
  };
}

/** "circle.png 160토큰" — every refusal names the file and what it costs. */
export function describeCost(name: string, tokens: number): string {
  return `${name} ${tokens.toLocaleString("en-US")}토큰`;
}
