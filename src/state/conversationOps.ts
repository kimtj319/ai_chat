import type { ChatMessage, MessageUsage } from "../api/types";

/** Sum of prompt/completion tokens across every message that has usage info. */
export function conversationTokenTotals(messages: ChatMessage[]): MessageUsage {
  return messages.reduce<MessageUsage>(
    (total, message) => {
      if (!message.usage) return total;
      return {
        promptTokens: total.promptTokens + message.usage.promptTokens,
        completionTokens: total.completionTokens + message.usage.completionTokens,
        totalTokens: total.totalTokens + message.usage.totalTokens,
      };
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}
