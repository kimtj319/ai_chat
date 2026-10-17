import { streamChatCompletion, type ChatCompletionRequestBody, type VllmStreamChunk } from "../vllm/client.js";
import { config, type VllmEndpoint } from "../config.js";
import type { VllmMessage } from "./historyBuilder.js";

/**
 * Two ways a turn is asked to stop thinking and write its answer instead.
 *
 * A model asked something genuinely hard can think for a very long time — this
 * app measured one turn that produced nothing at all for twenty minutes. In
 * "external" mode that is allowed; the answer is whatever the model eventually
 * reaches, however long it takes. In "normal" mode there is a safety-net
 * ceiling (below) so a forgotten tab does not run forever.
 *
 * Either mode also accepts a THIRD trigger, mode-agnostic: the person can
 * click "지금 답변하기" (answer now) once a turn has run long enough that the
 * client offers it. That is not a deadline — nobody configured a ceiling, the
 * person watching the turn asked for it — but it stops the turn the same way:
 * the model is asked, in a second call, to write the answer from the
 * reasoning it had already produced, so the work done up to that point is not
 * thrown away.
 *
 * The wrap-up call is deliberately unlike the one it replaces: no tools (it
 * must not start another round of research) and no thinking (it would hit the
 * same wall the trigger just cut through).
 */

/**
 * Three minutes, unless NORMAL_MODE_DEADLINE_MS says otherwise (config.ts).
 *
 * This is a backstop, not the primary way a "normal"-mode turn ends early —
 * that is now the person's own "지금 답변하기" click. The override exists
 * because the backstop itself is otherwise untestable without actually waiting
 * out the ceiling; operators can also use it to tune how long an unattended
 * turn is allowed to run.
 */
export const NORMAL_MODE_SAFETY_TIMEOUT_MS = config.normalModeDeadlineMs;

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
  /** Aborts when the client gives up, the safety net expires, OR answer-now fires. Use for the model calls. */
  readonly signal: AbortSignal;
  /**
   * Why `signal` is aborted, from THIS turn's own point of view — `null` means
   * either it never fired, or the client itself gave up (see the note below).
   */
  stopReason(): "deadline" | "answer-now" | null;
  dispose(): void;
}

/**
 * One signal that carries every reason a turn can stop, so callers pass a
 * single signal down and ask afterwards which one fired.
 */
export function startTurnDeadline(
  clientSignal: AbortSignal,
  afterMs: number | null,
  answerNowSignal: AbortSignal,
): TurnDeadline {
  const controller = new AbortController();
  let reason: "deadline" | "answer-now" | null = null;

  const onClientAbort = () => controller.abort();
  if (clientSignal.aborted) controller.abort();
  else clientSignal.addEventListener("abort", onClientAbort, { once: true });

  // Guarded so a click that arrives after the safety net already fired (or vice
  // versa) cannot relabel a reason the loop may already have acted on.
  const onAnswerNow = () => {
    if (reason === null) reason = "answer-now";
    controller.abort();
  };
  if (answerNowSignal.aborted) onAnswerNow();
  else answerNowSignal.addEventListener("abort", onAnswerNow, { once: true });

  const timer =
    afterMs === null
      ? undefined
      : setTimeout(() => {
          if (reason === null) reason = "deadline";
          controller.abort();
        }, afterMs);
  timer?.unref?.();

  return {
    signal: controller.signal,
    // The client winning the race is not a deadline or an answer-now request:
    // if the client itself gave up, that is what counts, and nobody is
    // waiting for a wrap-up any more.
    stopReason: () => (clientSignal.aborted ? null : reason),
    dispose() {
      if (timer) clearTimeout(timer);
      clientSignal.removeEventListener("abort", onClientAbort);
      answerNowSignal.removeEventListener("abort", onAnswerNow);
    },
  };
}

/** A cancelled fetch (AbortError) or a stream loop that saw its signal fire ("aborted-by-user"). */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "aborted-by-user");
}

function excerptReasoning(reasoning: string): string {
  const text = reasoning.trim();
  if (text.length <= MAX_REASONING_CHARS) return text;
  return `…(앞부분 생략)\n${text.slice(-MAX_REASONING_CHARS)}`;
}

/**
 * Why this turn is being asked to stop and write.
 *
 * "deadline" is the normal-mode safety net running out. "answer-now" is the
 * person clicking "지금 답변하기" — mode-agnostic, and unlike "deadline" it is
 * not a ceiling anyone configured. "empty-answer" is a turn that finished on
 * its own terms and left the answer blank — measured on wise-lloa-max, which
 * puts its whole working-out in reasoning_content and never writes a body.
 */
export type WrapUpReason =
  | { kind: "deadline"; deadlineMs: number }
  | { kind: "answer-now" }
  | { kind: "empty-answer" };

function leadSentence(reason: WrapUpReason): string {
  if (reason.kind === "deadline") {
    return `생각할 시간 ${describeDeadline(reason.deadlineMs)}이 지났습니다. 더 생각하지 말고, 지금까지 진행한 추론만으로 최종 답변을 작성하세요.`;
  }
  if (reason.kind === "answer-now") {
    return "사용자가 '지금 답변하기'를 눌렀습니다. 더 생각하거나 도구를 호출하지 말고, 지금까지 진행한 추론과 조사만으로 최종 답변을 지금 작성하세요.";
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
 *
 * Usage goes to `onUsage` rather than being dropped: on a turn that ends here
 * this call is often every visible completion token the turn produced.
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
  onUsage: (usage: NonNullable<VllmStreamChunk["usage"]>) => void;
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
    if (chunk.usage) input.onUsage(chunk.usage);
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/**
 * 마무리 답변(지금 답변하기·안전 상한·빈 답변 복구)에 넘길 이력.
 *
 * 예전에는 도구 루프가 시작되기 **전**의 이력(baseMessages)을 넘겼다. 그래서
 * 마무리 답변은 이번 턴의 도구 결과를 한 번도 보지 못했고, 도구를 다섯 번 부른
 * 뒤에 "지금 답변하기" 를 누르면 "요청하신 도구 호출을 아직 수행하지 않았습니다"
 * 라고 답했다(2026-09-23 운영 서버 실측). 사용자가 원한 것은 "그 시점까지 모은 정보로
 * 답하라" 이고, 모은 정보의 대부분이 바로 그 도구 결과다.
 *
 * 끝에 결과가 붙지 않은 tool_calls 가 남아 있으면 뗀다. 도구 호출과 결과는 실행이
 * 끝난 뒤 한꺼번에 쌓이므로 보통은 짝이 맞지만, 짝 없는 tool_calls 는 서버가 400 으로
 * 거절하므로 한 줄로 막아 둔다.
 */
export function messagesForWrapUp(messages: VllmMessage[]): VllmMessage[] {
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0) continue;
    const answered = new Set(out.slice(i + 1).filter((x) => x.role === "tool").map((x) => x.tool_call_id));
    if (m.tool_calls.every((tc) => answered.has(tc.id))) break;
    out.splice(i); // 짝 없는 호출부터 끝까지 버린다
    break;
  }
  return out;
}

/**
 * 모은 결과까지 넣어 마무리 답변을 시도하고, **첫 글자가 나오기 전에** 실패하면
 * 도구 결과 없이 한 번 더 시도한다. 결과를 넣으면 컨텍스트가 넘칠 수 있는데, 그때
 * 아무 답도 없는 것보다 추론만으로라도 답하는 편이 낫다. 이미 글자가 나간 뒤의
 * 실패는 되돌릴 수 없으므로 그대로 던진다. 사용자가 끊은 것도 그대로 던진다.
 */
export async function* wrapUpWithFallback(
  args: Omit<Parameters<typeof streamWrapUpAnswer>[0], "baseMessages">,
  withResults: VllmMessage[],
  withoutResults: VllmMessage[],
): AsyncGenerator<string, void, void> {
  let yielded = false;
  try {
    for await (const delta of streamWrapUpAnswer({ ...args, baseMessages: withResults })) {
      yielded = true;
      yield delta;
    }
  } catch (err) {
    if (yielded || isAbortError(err)) throw err;
    console.warn("[chat] 도구 결과를 넣은 마무리 답변이 실패해, 결과 없이 다시 시도합니다:", err);
    yield* streamWrapUpAnswer({ ...args, baseMessages: withoutResults });
  }
}
