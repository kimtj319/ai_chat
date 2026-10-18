import crypto from "node:crypto";
import type { StoredMessage } from "../types.js";
import { CANCELLED_BY_CLIENT, type TurnResult } from "./toolLoop.js";

/**
 * The assistant message a finished turn is stored as.
 *
 * One builder for every place that runs a turn, because two copies drifted:
 * the scheduled-turn copy left out contentPromotedFromReasoning, so a scheduled
 * answer restored from the reasoning field lost the note that says so
 * (src/components/MessageItem.tsx). Callers that need to change a field (the
 * chat route rewrites the error of a turn left during compaction) spread this
 * and override it.
 */
export function assistantMessageFromTurn(result: TurnResult, startedAt: number): StoredMessage {
  // 사용자가 멈춘 답은 실패가 아니다. 오류로 저장하면 다시 열었을 때 받은 데까지의
  // 글 아래에 "답변을 만들지 못했습니다" 카드가 붙었다(2026-10-18 감사 A1-01).
  const stopped = result.error === CANCELLED_BY_CLIENT;
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: result.content,
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    ...(result.toolResults.length ? { toolResults: result.toolResults } : {}),
    usage: result.usage,
    ...(result.error && !stopped ? { error: result.error } : {}),
    ...(stopped ? { stopped: true } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
    ...(result.contentPromotedFromReasoning ? { contentPromotedFromReasoning: true } : {}),
    durationMs: Date.now() - startedAt,
    createdAt: new Date().toISOString(),
  };
}
