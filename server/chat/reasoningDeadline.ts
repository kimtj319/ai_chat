import { streamChatCompletion, type ChatCompletionRequestBody } from "../vllm/client.js";
import { config, type VllmEndpoint } from "../config.js";
import type { VllmMessage } from "./historyBuilder.js";

/**
 * The "normal" reasoning mode: a ceiling on how long the model may think.
 *
 * A model asked something genuinely hard can think for a very long time — this
 * app measured one turn that produced nothing at all for twenty minutes. In
 * "external" mode that is allowed; the answer is whatever the model eventually
 * reaches. In "normal" mode the turn is stopped at the deadline and the model
 * is asked, in a second call, to write the answer from the reasoning it had
 * already produced. The user gets an answer built from real work rather than an
 * empty turn, and the work done up to the cut is not thrown away.
 *
 * The wrap-up call is deliberately unlike the one it replaces: no tools (it
 * must not start another round of research) and no thinking (it would hit the
 * same wall the deadline just cut through).
 */

/**
 * Three minutes, unless NORMAL_MODE_DEADLINE_MS says otherwise (config.ts).
 *
 * The override exists because the behaviour is otherwise untestable without
 * waiting three minutes on a model that may or may not be slow that run — the
 * turn this was written for finished in 35s once and ran past 20 minutes
 * another time. Operators can also use it to tune the ceiling.
 */
export const NORMAL_MODE_DEADLINE_MS = config.normalModeDeadlineMs;

/** Enough for the conclusions; the beginning of a long think is rarely the part that matters. */
const MAX_REASONING_CHARS = 12_000;
const WRAP_UP_MAX_TOKENS = 4096;

/**
 * The ceiling, said the way a person would. Rounding straight to minutes read
 * as "0분" the first time this was tested against a short override, and would
 * round 30s up to "1분" — so anything under a minute is stated in seconds.
 */
export function describeDeadline(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes}분` : `${minutes.toFixed(1)}분`;
}

export interface TurnDeadline {
  /** Aborts when the client gives up OR the deadline passes. Use for the model calls. */
  readonly signal: AbortSignal;
  /** True when this turn's own deadline is what stopped it. */
  expired(): boolean;
  dispose(): void;
}

/**
 * One signal that carries both reasons a turn can stop, so callers pass a
 * single signal down and ask afterwards which of the two fired.
 */
export function startTurnDeadline(clientSignal: AbortSignal, afterMs: number | null): TurnDeadline {
  const controller = new AbortController();
  let expired = false;

  const onClientAbort = () => controller.abort();
  if (clientSignal.aborted) controller.abort();
  else clientSignal.addEventListener("abort", onClientAbort, { once: true });

  const timer =
    afterMs === null
      ? undefined
      : setTimeout(() => {
          expired = true;
          controller.abort();
        }, afterMs);
  timer?.unref?.();

  return {
    signal: controller.signal,
    // The client winning the race is not a deadline: if both fired, whoever the
    // user is waiting on is the one that counts, and they have gone.
    expired: () => expired && !clientSignal.aborted,
    dispose() {
      if (timer) clearTimeout(timer);
      clientSignal.removeEventListener("abort", onClientAbort);
    },
  };
}

function excerptReasoning(reasoning: string): string {
  const text = reasoning.trim();
  if (text.length <= MAX_REASONING_CHARS) return text;
  return `…(앞부분 생략)\n${text.slice(-MAX_REASONING_CHARS)}`;
}

/**
 * Why this turn is being asked to stop and write.
 *
 * "deadline" is normal mode running out of time. "empty-answer" is a turn that
 * finished on its own terms and left the answer blank — measured on
 * wise-lloa-max, which puts its whole working-out in reasoning_content and
 * never writes a body.
 */
export type WrapUpReason = { kind: "deadline"; deadlineMs: number } | { kind: "empty-answer" };

function leadSentence(reason: WrapUpReason): string {
  if (reason.kind === "deadline") {
    return `생각할 시간 ${describeDeadline(reason.deadlineMs)}이 지났습니다. 더 생각하지 말고, 지금까지 진행한 추론만으로 최종 답변을 작성하세요.`;
  }
  return "추론은 끝났는데 사용자에게 보낼 답변 본문이 비어 있습니다. 더 생각하지 말고, 지금까지 진행한 추론만으로 최종 답변을 작성하세요.";
}

function instruction(reasoning: string, reason: WrapUpReason): string {
  const excerpt = excerptReasoning(reasoning);
  const head = [
    leadSentence(reason),
    "",
    "- 도구를 호출하지 마세요.",
    "- 추론 과정을 그대로 옮기지 말고, 사용자가 읽을 답변으로 정리하세요.",
    // A turn that argued itself out of a first answer used to publish both: a
    // measured wrap-up read "판정: 매칭 성공 … 정정: 매칭 실패" in one message.
    "- 추론 중에 세웠다가 스스로 뒤집은 결론은 쓰지 말고, 최종 결론만 쓰세요.",
    "- 확인하지 못한 부분이 있으면 답변 안에서 그렇다고 밝히고, 확인한 것과 섞지 마세요.",
  ].join("\n");
  if (excerpt.length === 0) {
    return `${head}\n\n아직 정리된 추론이 없다면, 질문에 대해 현재 아는 범위에서 답하고 무엇이 부족한지 밝히세요.`;
  }
  return `${head}\n\n지금까지의 추론:\n${excerpt}`;
}

/**
 * Streams the wrap-up answer: the model's own reasoning handed back to it with
 * an instruction to write the answer it never wrote.
 *
 * Runs on the CLIENT's signal, not the expired one: when a deadline sends it
 * here the deadline has already done its job, and this call is what the user is
 * now waiting for.
 */
export async function* streamWrapUpAnswer(input: {
  model: string;
  endpoint: VllmEndpoint;
  baseMessages: VllmMessage[];
  reasoning: string;
  temperature: number;
  topP: number;
  reason: WrapUpReason;
  clientSignal: AbortSignal;
}): AsyncGenerator<string, void, void> {
  const body: ChatCompletionRequestBody = {
    model: input.model,
    messages: [...input.baseMessages, { role: "user", content: instruction(input.reasoning, input.reason) }],
    stream: true,
    stream_options: { include_usage: true },
    temperature: input.temperature,
    top_p: input.topP,
    max_tokens: WRAP_UP_MAX_TOKENS,
    presence_penalty: 0,
    frequency_penalty: 0,
    chat_template_kwargs: { enable_thinking: false },
  };

  const stream = await streamChatCompletion(body, input.clientSignal, input.endpoint);
  for await (const chunk of stream) {
    if (input.clientSignal.aborted) return;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}
