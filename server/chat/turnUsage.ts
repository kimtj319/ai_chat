import type { MessageUsage, StoredMessage } from "../types.js";
import type { VllmStreamChunk } from "../vllm/client.js";

export type WireUsage = NonNullable<VllmStreamChunk["usage"]>;

/** a + b, where b is what a model call reported (total falls back to input + output). */
export function addWireUsage(a: MessageUsage | undefined, b: WireUsage): MessageUsage {
  const prompt = b.prompt_tokens ?? 0;
  const completion = b.completion_tokens ?? 0;
  return {
    promptTokens: (a?.promptTokens ?? 0) + prompt,
    completionTokens: (a?.completionTokens ?? 0) + completion,
    totalTokens: (a?.totalTokens ?? 0) + (b.total_tokens ?? prompt + completion),
  };
}

/**
 * 답변 곁에서 도는 모델 호출(제목 짓기·"하지 마" 판정)의 토큰을 그 턴의 답에 더한다.
 *
 * 저장 전에 끝난 호출은 저장할 답에 보태고(settle), 늦게 끝난 호출은 저장된 답을
 * 고쳐 보탠다(persist) — 판정은 답 뒤에 줄을 서므로 길게는 2분 뒤에 끝난다. 그때는
 * 스트림이 닫혀 있어 화면에는 대화를 다시 열 때 보인다. 답이 저장되지 않은 턴(실패·
 * 되돌림)의 곁 사용량은 붙일 곳이 없어 버린다.
 */
export function sideUsageMeter(persist: (messageId: string, usage: WireUsage) => Promise<void>) {
  let pending: MessageUsage | undefined;
  let savedId: string | null = null;
  return {
    add(usage: WireUsage): void {
      if (savedId === null) {
        pending = addWireUsage(pending, usage);
        return;
      }
      persist(savedId, usage).catch((err) =>
        console.warn("[usage] could not add a side call's tokens to the answer:", err instanceof Error ? err.message : err),
      );
    },
    /** 답을 저장하기 직전에 부른다. 이후의 곁 사용량은 이 답으로 간다. */
    settle(message: StoredMessage): StoredMessage {
      savedId = message.id;
      if (!pending) return message;
      return {
        ...message,
        usage: addWireUsage(message.usage, {
          prompt_tokens: pending.promptTokens,
          completion_tokens: pending.completionTokens,
          total_tokens: pending.totalTokens,
        }),
      };
    },
  };
}
