import { config } from "../config.js";
import type { Conversation } from "../types.js";
import { normalizeReasoningLevel } from "../types.js";

/**
 * What each model actually does with the reasoning controls, measured against
 * real endpoints rather than inferred from the family it was trained from
 * (139 runs, 2026-09-12).
 *
 * The one conclusion that shapes everything here: `reasoning_effort` is never
 * worth sending.
 *  - One gateway drops it before the model sees it. Proof: the nonsense value
 *    "banana" returned 200 there and 400 on a raw vLLM, and all 58 runs held
 *    prompt_tokens at 145 whatever was sent.
 *  - One model accepted and ignored it — low and medium came back byte
 *    identical at 1,994 reasoning characters and 922 completion tokens.
 *  - One honoured it, but not in order. medium thought LESS than low (383
 *    versus 459 tokens, reproducible at temperature 0), and "high" — a value
 *    this app's own scale contains — was rejected with a 400 that killed the
 *    whole request.
 * A thinking budget, by contrast, moves monotonically wherever it is honoured,
 * so the levels are driven by that instead.
 *
 * WHICH model gets which profile is deployment knowledge, not app knowledge, so
 * it lives in REASONING_PROFILES rather than in this file. Hard-coding the ids
 * here would mean every site that serves different models has to patch the
 * source to stop the app sending fields their gateway rejects.
 */

export type ReasoningControl = "budget" | "fixed";

interface ReasoningProfile {
  control: ReasoningControl;
  /**
   * Below this a budget stops buying shorter thinking and starts buying a
   * longer answer: one model at 32 cut reasoning to 76 characters and blew the
   * body up from 9 characters to 1,836, taking 12.3s to do it. That is what
   * `budget:256` in REASONING_PROFILES is for.
   */
  minBudget: number;
}

const FIXED: ReasoningProfile = { control: "fixed", minBudget: 0 };
const DEFAULT: ReasoningProfile = { control: "budget", minBudget: 128 };

/**
 * 어떤 모델이 어떤 프로필인지는 배포마다 다르다. `REASONING_PROFILES` 에
 * `패턴=프로필` 을 쉼표로 잇는다 — 패턴은 모델 id 에 **부분 문자열**로 맞춰
 * 보므로, 같은 계열의 새 빌드가 나와도 그대로 걸린다.
 *
 *   REASONING_PROFILES=some-model=fixed,other-model=budget:256
 *
 * `fixed` 는 "고를 것이 없다"(추론 관련 필드를 아예 보내지 않는다), `budget:N`
 * 은 "예산으로 조절하되 N 아래로는 내리지 않는다". 아무것도 적지 않으면 모든
 * 모델이 기본 프로필을 쓰는데, 그것은 측정된 엔드포인트들이 **모두** 받아들인
 * 필드만 보낸다 — 재 본 적 없는 모델에게 가장 안전한 쪽이다.
 */
export interface ProfileRule {
  /** 모델 id 에 이 문자열이 들어 있으면 적용된다. 소문자로 비교한다. */
  pattern: string;
  profile: ReasoningProfile;
}

/**
 * 설정 문자열을 규칙으로 바꾼다. 알아볼 수 없는 항목은 **버리지 않고 알린다**:
 * 오타 하나가 조용히 무시되면 그 모델만 기본 프로필로 떨어져, 아무 오류 없이
 * 추론 설정이 달라진다.
 */
export function parseReasoningProfiles(raw: string): { rules: ProfileRule[]; errors: string[] } {
  const rules: ProfileRule[] = [];
  const errors: string[] = [];
  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    if (eq <= 0) {
      errors.push(`"${text}": 패턴=프로필 꼴이 아닙니다.`);
      continue;
    }
    const pattern = text.slice(0, eq).trim().toLowerCase();
    const spec = text.slice(eq + 1).trim().toLowerCase();
    if (!pattern) {
      errors.push(`"${text}": 패턴이 비었습니다.`);
      continue;
    }
    if (spec === "fixed") {
      rules.push({ pattern, profile: FIXED });
      continue;
    }
    const budget = /^budget(?::(\d+))?$/.exec(spec);
    if (budget) {
      const min = budget[1] === undefined ? DEFAULT.minBudget : Number(budget[1]);
      rules.push({ pattern, profile: { control: "budget", minBudget: min } });
      continue;
    }
    errors.push(`"${text}": 프로필은 fixed 또는 budget[:최소값] 이어야 합니다.`);
  }
  return { rules, errors };
}

const configured = parseReasoningProfiles(config.reasoningProfiles);
for (const message of configured.errors) {
  console.warn(`[reasoning] REASONING_PROFILES ${message}`);
}

export function reasoningProfileFor(model: string): ReasoningProfile {
  const id = model.toLowerCase();
  // 먼저 적은 것이 이긴다 — 겹치는 패턴을 적었을 때 순서가 뜻을 갖는다.
  for (const rule of configured.rules) {
    if (id.includes(rule.pattern)) return rule.profile;
  }
  return DEFAULT;
}

/** True when the model gives the user nothing to choose, so the UI should say so. */
export function reasoningIsFixed(model: string): boolean {
  return reasoningProfileFor(model).control === "fixed";
}

export function reasoningParamsFor(conversation: Conversation, model: string) {
  const profile = reasoningProfileFor(model);
  // Every knob measured as ignored here, including enable_thinking:false — five
  // runs of it still produced 1,835 to 2,152 characters of reasoning. Sending
  // them would only make the request longer and the promise on the button false.
  if (profile.control === "fixed") return {};

  const level = normalizeReasoningLevel(conversation.settings.reasoningLevel);
  if (level === "off") {
    return { chat_template_kwargs: { enable_thinking: false as const } };
  }

  // The user's budget is the ceiling, at the top level: the same number nested
  // under chat_template_kwargs.thinking_budget was ignored by all three models.
  const ceiling = conversation.settings.thinkingTokenBudget;
  const share = level === "low" ? 8 : level === "medium" ? 4 : 1;
  const budget = Math.max(profile.minBudget, Math.round(ceiling / share));
  return {
    chat_template_kwargs: { enable_thinking: true as const },
    thinking_token_budget: Math.min(budget, ceiling),
  };
}
