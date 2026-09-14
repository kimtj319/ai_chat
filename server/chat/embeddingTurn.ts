import { createEmbedding } from "../vllm/client.js";
import type { VllmEndpoint } from "../config.js";
import type { Conversation, MessageEmbedding, MessageUsage } from "../types.js";

/**
 * An embedding turn: the user types text, the model returns its vector.
 *
 * Nothing from the chat path applies here and none of it is called — no system
 * prompt, no tools, no tool loop, no /tokenize, no context budget, no
 * compaction. Those exist to fit a growing conversation into a context window;
 * an embedding request is one string in, one vector out, and the previous turns
 * are not even sent.
 */

/**
 * Cosine similarity of two equal-length vectors, or null when they cannot be
 * compared (different dimensions — two different embedding models in one
 * conversation — or a zero vector, where the cosine is undefined rather than 0).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The most recent stored embedding in this conversation, if there is one. */
export function previousEmbedding(conversation: Conversation): { messageId: string; embedding: MessageEmbedding } | null {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const message = conversation.messages[i]!;
    if (message.embedding) return { messageId: message.id, embedding: message.embedding };
  }
  return null;
}

/**
 * Embed `text` and attach the comparison to the previous vector in the same
 * conversation. `conversation` must already contain the new user message (it is
 * skipped here — a user message carries no embedding).
 */
export async function runEmbeddingTurn(
  conversation: Conversation,
  endpoint: VllmEndpoint,
  model: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ embedding: MessageEmbedding; usage: MessageUsage }> {
  const result = await createEmbedding(endpoint, model, text, signal);
  const previous = previousEmbedding(conversation);
  const cosine = previous ? cosineSimilarity(result.vector, previous.embedding.vector) : null;
  const embedding: MessageEmbedding = {
    model: result.model,
    dimensions: result.dim,
    vector: result.vector,
    // Always present, null when there was no previous vector to compare with.
    cosineToPrevious: cosine,
    ...(previous && cosine !== null ? { previousMessageId: previous.messageId } : {}),
  };
  return { embedding, usage: embeddingUsage(result.usage) };
}

/** The gateway's own usage numbers, in the shape every message reports them. */
export function embeddingUsage(usage: { prompt_tokens?: number; total_tokens?: number } | undefined): MessageUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  return { promptTokens: prompt, completionTokens: 0, totalTokens: usage?.total_tokens ?? prompt };
}
