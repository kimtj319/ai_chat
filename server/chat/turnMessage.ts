import crypto from "node:crypto";
import type { StoredMessage } from "../types.js";
import type { TurnResult } from "./toolLoop.js";

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
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: result.content,
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    ...(result.toolResults.length ? { toolResults: result.toolResults } : {}),
    usage: result.usage,
    ...(result.error ? { error: result.error } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
    ...(result.contentPromotedFromReasoning ? { contentPromotedFromReasoning: true } : {}),
    durationMs: Date.now() - startedAt,
    createdAt: new Date().toISOString(),
  };
}
