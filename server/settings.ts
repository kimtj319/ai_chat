// Conversation settings: the one part of the shared types with runtime code
// (normalisers, bounds, the defaults). Re-exported from types.ts.

/**
 * Qwen3.8's effort ladder is low < medium < xhigh; there is no "high" — the
 * servers reject it with HTTP 400 (measured 2026-09-11 on both endpoints).
 * "high" is still accepted when reading older stored conversations and is
 * normalised to "xhigh"; see normalizeReasoningLevel.
 */
export type ReasoningLevel = "off" | "low" | "medium" | "xhigh";

/** Coerce any stored/incoming value to a level the servers accept. */
export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  if (value === "low" || value === "medium" || value === "xhigh" || value === "off") return value;
  if (value === "high") return "xhigh"; // legacy value from before the ladder was verified
  return "off";
}

/**
 * What happens when the model thinks for a long time.
 *
 * "external" lets it think to its own end, however long that takes — the
 * answer is whatever the model eventually arrives at. "normal" puts a ceiling
 * on it: past the deadline the server stops the generation and asks for the
 * answer to be written from the reasoning collected so far, so a turn always
 * ends with something rather than running unbounded.
 */
export type ReasoningMode = "normal" | "external";

/** Anything unrecognised (including a record written before modes existed) is "external". */
export function normalizeReasoningMode(value: unknown): ReasoningMode {
  return value === "normal" ? "normal" : "external";
}

export interface ConversationSettings {
  reasoningLevel: ReasoningLevel;
  reasoningMode: ReasoningMode;
  thinkingTokenBudget: number;
  temperature: number;
  topP: number;
  maxTokens: number;
  presencePenalty: number;
  frequencyPenalty: number;
  seed: number | null;
}

/**
 * Check a settings patch before it is stored.
 *
 * Without this the PATCH route spread whatever arrived straight onto the
 * conversation, and the values it stored went to vLLM on the next turn. That
 * made a conversation permanently unusable from one bad request — measured on
 * the deployment: `seed: "abc"` produced
 * "Input should be a valid integer, unable to parse string as an integer" and
 * `topP: 99` produced "top_p must be in (0, 1], got 99.0", on every later turn,
 * with no way to recover from the UI because the UI never sends those values.
 *
 * Out-of-range is refused rather than clamped: a number silently changed to
 * something else is the same surprise in a quieter form, and the caller who
 * sent 99 wants to know that 99 is not a top_p.
 */
export interface SettingsPatchProblem {
  field: string;
  message: string;
}

const SETTINGS_BOUNDS = {
  thinkingTokenBudget: { min: 0, max: 65536, integer: true },
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false, exclusiveMin: true },
  maxTokens: { min: 1, max: 65536, integer: true },
  presencePenalty: { min: -2, max: 2, integer: false },
  frequencyPenalty: { min: -2, max: 2, integer: false },
} as const;

export function validateSettingsPatch(
  input: Record<string, unknown>,
): { ok: true; value: Partial<ConversationSettings> } | { ok: false; problem: SettingsPatchProblem } {
  const value: Partial<ConversationSettings> = {};

  if (input.reasoningLevel !== undefined) value.reasoningLevel = normalizeReasoningLevel(input.reasoningLevel);
  if (input.reasoningMode !== undefined) value.reasoningMode = normalizeReasoningMode(input.reasoningMode);

  for (const [field, bound] of Object.entries(SETTINGS_BOUNDS)) {
    const raw = input[field];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, problem: { field, message: `${field}은(는) 숫자여야 합니다.` } };
    }
    if (bound.integer && !Number.isInteger(raw)) {
      return { ok: false, problem: { field, message: `${field}은(는) 정수여야 합니다.` } };
    }
    const tooSmall = "exclusiveMin" in bound && bound.exclusiveMin ? raw <= bound.min : raw < bound.min;
    if (tooSmall || raw > bound.max) {
      const low = "exclusiveMin" in bound && bound.exclusiveMin ? `${bound.min} 초과` : `${bound.min} 이상`;
      return { ok: false, problem: { field, message: `${field}은(는) ${low} ${bound.max} 이하여야 합니다.` } };
    }
    (value as Record<string, number>)[field] = raw;
  }

  if (input.seed !== undefined) {
    // null is "let the server pick", which is the default and not an error.
    if (input.seed === null) value.seed = null;
    else if (typeof input.seed === "number" && Number.isSafeInteger(input.seed)) value.seed = input.seed;
    else return { ok: false, problem: { field: "seed", message: "seed은(는) 정수이거나 null이어야 합니다." } };
  }

  // Anything else the caller sent is dropped rather than stored: an unknown key
  // reaching vLLM is exactly the failure this function exists to prevent.
  return { ok: true, value };
}

export const DEFAULT_SETTINGS: ConversationSettings = {
  reasoningLevel: "off",
  reasoningMode: "external",
  /**
   * ~34 seconds of thinking before the answer starts, at the decode rate this
   * deployment actually runs at.
   *
   * Measured on the 27B (H200 x1): one stream decodes at 62.9 tok/s and eight
   * concurrent streams still get 59.8 tok/s each — 478 tok/s aggregate, a 5%
   * per-stream loss. Eight people sharing the model therefore do not slow each
   * other down much; what they each wait on is their own budget divided by
   * ~60 tok/s. The old 4096 was 68 seconds of silence before a single word.
   *
   * The budget is real, not advisory: 512 produced 568 characters of thinking
   * in 22.7s and 8192 produced 8,577 in 95.2s on the same question.
   */
  thinkingTokenBudget: 2048,
  temperature: 0.7,
  topP: 0.8,
  maxTokens: 16384,
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: null,
};
