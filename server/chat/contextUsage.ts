import { config } from "../config.js";
import type { Conversation } from "../types.js";
import { endpointForOwner, modelAccessForOwner } from "../vllm/access.js";
import { countPromptTokens, estimatePromptTokens, resolveModel } from "../vllm/client.js";
import { mcpToolsForOwner } from "../mcp/toolAdapter.js";
import { buildHistoryMessages } from "./historyBuilder.js";
import { buildTurnTools } from "./turnTools.js";
import { historyBuildOptions, needsSummary } from "./historySummary.js";

/**
 * How full a conversation's context is for one model — what the composer's
 * meter shows. Measured on the history the next turn would actually send (the
 * stored summary in place of what it covers, past tool results capped), with
 * that model's own tokenizer, so switching models re-measures rather than
 * rescaling a number another tokenizer produced. The tool definitions the
 * next turn would offer are counted too: with every built-in tool on they are
 * ~8k tokens, most of a short conversation's prompt (measured 2026-11-03).
 */
export interface ContextUsage {
  model: string;
  tokens: number;
  /** Null when neither the server nor MODEL_CONTEXT_LENGTHS gives a window. */
  contextWindow: number | null;
  /** False when `tokens` is a character estimate (no /tokenize there, or no key for it). */
  exact: boolean;
  /**
   * Whether the next question will summarise the earlier conversation first —
   * decided by needsSummary itself, on the history with the tool definitions,
   * exactly as the next turn decides it (chat/historySummary.ts).
   */
  willSummarize: boolean;
  /** Where that summary first fires, as a share of the window (for the explanation). */
  summaryRatio: number;
  /** Where tools stop being offered for the rest of a turn (chat/toolLoop.ts). */
  toolStopRatio: number;
}

export async function contextUsage(conversation: Conversation, ownerId: string, requestedModel?: string): Promise<ContextUsage> {
  const access = await modelAccessForOwner(ownerId);
  const resolved = await resolveModel(requestedModel?.trim() || conversation.model, access.allows);
  const [messages, mcp] = await Promise.all([
    buildHistoryMessages(conversation, ownerId, historyBuildOptions(conversation)),
    mcpToolsForOwner(ownerId),
  ]);
  const { tools } = buildTurnTools(conversation, mcp.tools, false);
  let tokens: number;
  let exact = false;
  let reported: number | null = null;
  try {
    const endpoint = await endpointForOwner(resolved.endpoint, ownerId);
    const withTools = await countPromptTokens(endpoint, resolved.model, messages, tools);
    tokens = withTools.tokens;
    exact = withTools.exact;
    reported = withTools.maxModelLen;
  } catch {
    // No personal key for a wise model: the meter still shows an estimate.
    tokens = estimatePromptTokens(messages, tools);
  }
  const contextWindow = resolved.maxModelLen ?? reported;
  return {
    model: resolved.model,
    tokens,
    contextWindow,
    exact,
    willSummarize: needsSummary(conversation, tokens, contextWindow),
    summaryRatio: Math.min(config.contextToolStopRatio, config.contextHistorySummaryRatio),
    toolStopRatio: config.contextToolStopRatio,
  };
}
