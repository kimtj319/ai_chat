import type { ChatMessage, ConversationSettings } from "../api/types";

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * The file the header's save button writes: the history of one conversation.
 *
 * Deliberately NOT the conversation object. That carries the app's
 * configuration for the chat — id, system prompt, sampling settings, the
 * enabled tool list — none of which is history, and all of which the sidebar's
 * "내보내기" still writes in full for the round trip that can restore it. What
 * a reader wants out of this button is the exchange itself, with just enough
 * heading to know which conversation and which model produced it.
 */
export function conversationHistoryFile(
  conversation: { title: string; kind?: string; model: string; createdAt: string; updatedAt: string },
  // Already in wire shape: the caller owns the conversion, because the client's
  // in-flight message type is a view concern this module does not know about.
  messages: ChatMessage[],
): Record<string, unknown> {
  return {
    title: conversation.title,
    kind: conversation.kind ?? "chat",
    model: conversation.model,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages,
  };
}

/**
 * What an import can actually restore. The API contract has no endpoint to
 * replay arbitrary message history into a conversation (only
 * `POST /conversations/:id/messages`, which triggers a real model call), so
 * an imported file's `messages` cannot be restored — only the conversation's
 * metadata (title/systemPrompt/settings/enabledTools) can.
 */
export interface ImportedConversationShell {
  title: string;
  systemPrompt: string;
  settings?: ConversationSettings;
  enabledTools?: string[];
  droppedMessageCount: number;
}

function isConversationSettings(value: unknown): value is ConversationSettings {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.reasoningLevel === "string" &&
    typeof s.thinkingTokenBudget === "number" &&
    typeof s.temperature === "number" &&
    typeof s.topP === "number" &&
    typeof s.maxTokens === "number" &&
    typeof s.presencePenalty === "number" &&
    typeof s.frequencyPenalty === "number" &&
    (s.seed === null || typeof s.seed === "number")
  );
}

function isConversationLike(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>).title === "string";
}

/**
 * Parse a previously exported JSON blob into conversation shells ready to be
 * recreated via the API. Accepts either a single exported conversation or an
 * array of them (as produced by "export all"). Unrecognized entries are
 * skipped.
 */
export function parseImportedConversations(raw: unknown): ImportedConversationShell[] {
  const candidates = Array.isArray(raw) ? raw : [raw];
  const shells: ImportedConversationShell[] = [];

  for (const candidate of candidates) {
    if (!isConversationLike(candidate)) continue;
    const messages = Array.isArray(candidate.messages) ? candidate.messages : [];
    shells.push({
      title: typeof candidate.title === "string" ? candidate.title : "가져온 대화",
      systemPrompt: typeof candidate.systemPrompt === "string" ? candidate.systemPrompt : "",
      settings: isConversationSettings(candidate.settings) ? candidate.settings : undefined,
      enabledTools: Array.isArray(candidate.enabledTools) ? candidate.enabledTools.filter((t) => typeof t === "string") : undefined,
      droppedMessageCount: messages.length,
    });
  }

  return shells;
}
