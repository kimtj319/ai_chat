import { config } from "../config.js";

/**
 * Context windows for models whose server does not report one. The WiseLLoA
 * gateway (LiteLLM) lists its models without max_model_len, and without a
 * window the history summary, the context budget and the composer's context
 * meter all switch off for them — a long conversation moved onto one of them
 * failed outright with a context-length error. A reported window always wins.
 */
export interface ContextLengthRule {
  /** Lower-cased substring of the model id; the first matching rule wins. */
  pattern: string;
  tokens: number;
}

/** "pattern=tokens" entries separated by commas. Unreadable entries are reported, not dropped silently. */
export function parseContextLengths(raw: string): { rules: ContextLengthRule[]; errors: string[] } {
  const rules: ContextLengthRule[] = [];
  const errors: string[] = [];
  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    const pattern = eq > 0 ? text.slice(0, eq).trim().toLowerCase() : "";
    const tokens = eq > 0 ? Number(text.slice(eq + 1).trim()) : NaN;
    if (!pattern || !Number.isInteger(tokens) || tokens <= 0) {
      errors.push(`"${text}": 패턴=토큰수 꼴이어야 합니다(예: wise-lloa-max=131072).`);
      continue;
    }
    rules.push({ pattern, tokens });
  }
  return { rules, errors };
}

const configured = parseContextLengths(config.modelContextLengths);
for (const message of configured.errors) console.warn(`[vllm] MODEL_CONTEXT_LENGTHS ${message}`);

/** The configured window for this model id, or null. */
export function configuredContextLength(modelId: string, rules: readonly ContextLengthRule[] = configured.rules): number | null {
  const id = modelId.toLowerCase();
  return rules.find((rule) => id.includes(rule.pattern))?.tokens ?? null;
}
