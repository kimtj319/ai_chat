import { config } from "../config.js";
import { DEFAULT_SETTINGS } from "../settings.js";

/**
 * The temperature and top_p a model is sent while the conversation still has
 * the app's own defaults.
 *
 * Those defaults (0.7 / 0.8, server/settings.ts) are Qwen's recommendation, and
 * they used to go to every model. DeepSeek V4 is published with 1.0 / 1.0, and a
 * narrower top_p is the direction that makes a model more likely to fall into a
 * loop — the failure seen on DeepSeek V4.1 Flash on 2026-11-05.
 *
 * Which model gets what is deployment knowledge, like REASONING_PROFILES, so it
 * lives in SAMPLING_PROFILES: "pattern=temperature/top_p", comma separated, the
 * pattern a lower-cased substring of the model id. A value the person set on the
 * conversation always wins; only the untouched defaults are replaced.
 */
export interface SamplingDefaults {
  temperature: number;
  topP: number;
}

interface SamplingRule {
  pattern: string;
  defaults: SamplingDefaults;
}

export function parseSamplingProfiles(raw: string): { rules: SamplingRule[]; errors: string[] } {
  const rules: SamplingRule[] = [];
  const errors: string[] = [];
  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const match = /^([^=]+)=\s*([0-9.]+)\s*\/\s*([0-9.]+)$/.exec(text);
    const temperature = Number(match?.[2]);
    const topP = Number(match?.[3]);
    if (!match || !Number.isFinite(temperature) || !Number.isFinite(topP)) {
      errors.push(`"${text}": 패턴=temperature/top_p 꼴이 아닙니다.`);
      continue;
    }
    // The same ranges the settings PATCH enforces (server/settings.ts).
    if (temperature < 0 || temperature > 2 || topP <= 0 || topP > 1) {
      errors.push(`"${text}": temperature 는 0~2, top_p 는 0 초과 1 이하여야 합니다.`);
      continue;
    }
    rules.push({ pattern: match[1]!.trim().toLowerCase(), defaults: { temperature, topP } });
  }
  return { rules, errors };
}

const configured = parseSamplingProfiles(config.samplingProfiles);
for (const message of configured.errors) {
  console.warn(`[sampling] SAMPLING_PROFILES ${message}`);
}

/** The model's own defaults, or null when it uses the app's. The first matching entry wins. */
export function samplingDefaultsFor(model: string): SamplingDefaults | null {
  const id = model.toLowerCase();
  for (const rule of configured.rules) {
    if (id.includes(rule.pattern)) return rule.defaults;
  }
  return null;
}

/** What a request for `model` carries, given the conversation's stored settings. */
export function effectiveSampling(settings: { temperature: number; topP: number }, model: string): SamplingDefaults {
  const own = { temperature: settings.temperature, topP: settings.topP };
  const untouched = settings.temperature === DEFAULT_SETTINGS.temperature && settings.topP === DEFAULT_SETTINGS.topP;
  if (!untouched) return own;
  return samplingDefaultsFor(model) ?? own;
}
