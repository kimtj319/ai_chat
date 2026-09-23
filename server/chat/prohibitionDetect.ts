import { resolveModel, streamChatCompletion, type ChatCompletionRequestBody } from "../vllm/client.js";
import { RULE_MAX_CHARS, RULE_MIN_CHARS } from "../storage/prohibitionsStore.js";

/**
 * 사용자의 말에서 "하지 말라" 는 뜻을 찾아 규칙 한 줄로 옮긴다.
 *
 * 판단은 모델에 맡긴다. "~하지 마" 만 보는 패턴으로는 "그렇게 길게 쓸 필요 없어요",
 * "또 영어로 답했네요" 같은 말을 놓치고, 반대로 "이 에러가 안 사라져요" 같은 말을
 * 잡는다. 대신 모델이 찾은 것은 곧바로 반영하지 않고 검토 대기로만 보낸다
 * (storage/prohibitionsStore.ts 의 설명 참고) — 여기서의 오탐은 사용자가 한 번
 * 지우면 끝나는 비용이다.
 *
 * titleSummary.ts 와 같은 원칙으로 쓴다: 던지지 않고, 답변 옆에서 돌며, 실패하면
 * null 이다. 사용자는 이것을 기다리지 않는다.
 */

const MAX_TOKENS = 200;
const THINKING_RETRY_MAX_TOKENS = 1024;
/** 직전 답변은 "무엇에 대한 불만인지" 를 알 만큼만 싣는다. */
const MAX_ASSISTANT_CHARS = 1_500;
const MAX_USER_CHARS = 1_500;

const INSTRUCTION = [
  "너는 대화 기록을 읽고 판정만 하는 분석기다. 아래는 AI 어시스턴트의 직전 답변과, 그 뒤에 사용자가 보낸 말이다.",
  "",
  "사용자의 말에 어시스턴트가 **앞으로도 하지 말았으면 하는 행동**이 담겨 있는지 판정하라.",
  "- 해당: 명시적 금지(\"~하지 마\", \"~는 빼 줘\"), 반복된 행동에 대한 불만(\"또 영어로 답했네\", \"너무 길어\"), 선호의 부정(\"표로 만들 필요 없어\").",
  "- 해당 아님: 이번 질문의 내용 자체(코드의 오류, 상황에 대한 불평), 이번 한 번만의 수정 요청(\"이 숫자 틀렸어\", \"다시 해 줘\"), 칭찬, 새 질문.",
  "",
  "해당하면 그 행동을 다른 대화에서도 통하는 일반 규칙 한 문장으로 적어라. 한국어, \"~하지 않는다\" 꼴, " + RULE_MAX_CHARS + "자 이내.",
  "이번 대화에만 있는 고유명사나 내용은 넣지 마라.",
  "",
  "JSON 한 줄만 출력하라. 설명을 덧붙이지 마라.",
  '해당: {"negative": true, "rule": "..."}',
  '해당 아님: {"negative": false}',
].join("\n");

export interface DetectInput {
  /** 사용자의 말 바로 앞 답변. 없으면(첫 메시지) 판정하지 않는다. */
  assistant: string;
  user: string;
  model: string;
  signal: AbortSignal;
}

/**
 * 모델의 답에서 규칙을 꺼낸다. 코드 펜스·앞뒤 말·<think> 블록을 견딘다.
 * 규칙이 없거나 길이가 벗어나면 null.
 */
export function parseDetection(raw: string): string | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { negative, rule } = parsed as { negative?: unknown; rule?: unknown };
  if (negative !== true || typeof rule !== "string") return null;
  const cleaned = rule.replace(/\s+/g, " ").replace(/^[-*]\s+/, "").trim();
  if (cleaned.length < RULE_MIN_CHARS || cleaned.length > RULE_MAX_CHARS) return null;
  return cleaned;
}

/**
 * enable_thinking:false 를 무시하는 모델을 위해 한 번 더 부른다(titleSummary.ts 와
 * 같은 이유). 두 호출 모두 같은 요청 모양이다.
 */
async function complete(prompt: string, requestedModel: string, maxTokens: number, signal: AbortSignal): Promise<string | null> {
  const { model, endpoint } = await resolveModel(requestedModel);
  async function attempt(budget: number): Promise<{ text: string; thought: boolean }> {
    const body: ChatCompletionRequestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.1,
      top_p: 0.9,
      max_tokens: budget,
      presence_penalty: 0,
      frequency_penalty: 0,
      chat_template_kwargs: { enable_thinking: false },
    };
    let text = "";
    let thought = false;
    const stream = await streamChatCompletion(body, signal, endpoint);
    for await (const chunk of stream) {
      if (signal.aborted) break;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning ?? delta?.reasoning_content) thought = true;
      if (delta?.content) text += delta.content;
    }
    return { text, thought };
  }
  const first = await attempt(maxTokens);
  if (signal.aborted) return null;
  if (first.text.trim() || !first.thought) return first.text;
  const second = await attempt(maxTokens + THINKING_RETRY_MAX_TOKENS);
  return signal.aborted ? null : second.text;
}

export async function detectProhibition(input: DetectInput): Promise<string | null> {
  const user = input.user.trim();
  const assistant = input.assistant.trim();
  // 판정할 맥락이 없다. 첫 메시지의 "~하지 마" 는 이번 요청의 조건일 뿐이다.
  if (!user || !assistant) return null;
  // 짧은 새 질문 대부분을 모델을 부르지 않고 거른다. 부정·불만의 단서가 하나도 없는
  // 말은 판정할 거리가 없다 — 모든 턴에 모델 호출을 하나 더 얹지 않기 위한 문턱이다.
  if (!NEGATIVE_CUE.test(user)) return null;
  try {
    const prompt = `${INSTRUCTION}\n\n[직전 답변]\n${assistant.slice(0, MAX_ASSISTANT_CHARS)}\n\n[사용자의 말]\n${user.slice(0, MAX_USER_CHARS)}`;
    const raw = await complete(prompt, input.model, MAX_TOKENS, input.signal);
    return raw ? parseDetection(raw) : null;
  } catch (err) {
    console.warn("[prohibitions] detection failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 모델을 부를 가치가 있는 말인지 가르는 넓은 체. 놓치는 것보다 한 번 더 부르는
 * 편이 싸므로 넓게 잡는다 — 여기를 통과한 말의 최종 판정은 모델이 한다.
 */
export const NEGATIVE_CUE =
  /(말[아고라자]|마[세요라십]|마\s*$|마[.!?]|않[게았도는으]|안\s*[해했돼되써쓰]|없[어었다이습]|필요\s*없|하지\s*마|빼[줘주고라]|그만|제발|자꾸|또\s|왜\s|싫|별로|너무|지나치|과하|이상하|틀렸|잘못|아니[라야고]|don'?t|do not|stop|never|no more|too )/i;

const CONSOLIDATE_INSTRUCTION = [
  "아래는 한 사용자가 AI 어시스턴트에게 하지 말라고 한 규칙 목록이다. 이 목록을 정리하라.",
  "",
  "- 같은 뜻이거나 한 규칙이 다른 규칙을 포함하면 하나로 합친다.",
  "- 비슷한 것끼리 묶어서 더 일반적인 한 문장으로 쓴다. 단, 원래 규칙이 금지하던 것을 빠뜨리지 마라.",
  "- 서로 다른 규칙은 그대로 둔다. 새 규칙을 지어내지 마라.",
  "- 한 줄에 하나씩, \"- \" 로 시작하는 목록만 출력한다. 제목이나 설명을 붙이지 마라.",
  "",
  "목록:",
].join("\n");

/**
 * 정리안의 모양을 검사한다. 목록 줄만 남기고, 원래보다 길어졌거나 비었으면 null —
 * "정리" 가 목록을 늘린다면 그것은 정리가 아니다.
 */
export function parseConsolidation(raw: string, originalChars: number): string | null {
  const lines = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+\S/.test(line))
    .map((line) => `- ${line.replace(/^([-*]|\d+\.)\s+/, "").trim()}`);
  if (lines.length === 0) return null;
  const text = lines.join("\n");
  if (text.length >= originalChars) return null;
  return text;
}

/** 반영 목록(active)을 묶어 줄인 안. 저장하지 않는다 — 사용자가 보고 고른다. */
export async function consolidateProhibitions(items: string[], signal: AbortSignal): Promise<string | null> {
  if (items.length < 2) return null;
  const original = items.map((item) => `- ${item}`).join("\n");
  const raw = await complete(`${CONSOLIDATE_INSTRUCTION}\n${original}`, "", 2_000, signal);
  return raw ? parseConsolidation(raw, original.length) : null;
}
