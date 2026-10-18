import type { ConversationSettings } from "../settings.js";

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultRecord {
  id: string;
  name: string;
  ok: boolean;
  result?: unknown;
  durationMs: number;
  error?: string;
}

export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type MessageRole = "user" | "assistant";

export type AttachmentKind = "image" | "text";

/**
 * Machine-readable refusal reason, sent alongside the human `error` string so
 * the UI can pick its own wording instead of matching on Korean prose.
 */
export type AttachmentErrorCode =
  | "too_large"
  | "unsupported_type"
  | "unsupported_document"
  | "undecodable_text"
  | "too_many"
  | "quota"
  | "rate_limited";

/**
 * One stored attachment, as the upload route returns it and as it is persisted
 * on the user message that references it. The bytes live beside it on disk
 * (storage/attachmentStore.ts); this is only the metadata.
 */
export interface MessageAttachment {
  id: string;
  kind: AttachmentKind;
  /** The uploaded filename, for display only — never used to build a path. */
  name: string;
  /** Sniffed from the magic bytes, not from the declared Content-Type. */
  mime: string;
  bytes: number;
  /** Images only, when the container header was readable. */
  width?: number;
  height?: number;
  /**
   * What this attachment costs the prompt. Exact for images (the server's own
   * clamp(round(w*h/1000), 66, 16386)), a character estimate for text.
   */
  estimatedTokens?: number;
  /** Text only: characters after the UTF-8 decode. */
  chars?: number;
  /** Text only: whether the full text is inlined into the prompt. */
  inlined?: boolean;
  createdAt: string;
}

/**
 * The result of an embedding turn, stored on the assistant message.
 *
 * SIZE: `vector` is the model's full output — 1024 floats for a typical
 * embedding model — which serialises to roughly 20KB of JSON per
 * message. A 50-turn embedding conversation is therefore a ~1MB file. That is
 * accepted deliberately: the vector IS the answer here, and storing a truncated
 * one would make the stored conversation useless for the comparison it exists
 * for. Chat conversations are unaffected.
 */
export interface MessageEmbedding {
  /** The model id the server actually used, as the response reported it. */
  model: string;
  dimensions: number;
  vector: number[];
  /**
   * Cosine similarity against the previous embedding in this conversation, and
   * which message that was. A wall of 1024 numbers with nothing to compare it
   * to is not a result anyone can act on.
   *
   * NULL, not omitted and not 0, when this is the first embedding of the
   * conversation: "there was nothing to compare with" and "the two vectors are
   * orthogonal" are different facts and the UI shows them differently.
   *
   * Token usage is NOT repeated here — it is on the message's own `usage`
   * (usage.promptTokens), where every other kind of turn reports it.
   */
  cosineToPrevious: number | null;
  previousMessageId?: string;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** User messages only: the attachments sent with this message. */
  attachments?: MessageAttachment[];
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  toolResults?: ToolResultRecord[];
  usage?: MessageUsage;
  /** How long the server took to produce this answer, in milliseconds. */
  durationMs?: number;
  /** Embedding conversations only: the vector this turn produced. */
  embedding?: MessageEmbedding;
  error?: string;
  /**
   * Informational, unlike `error`: the turn completed, but in a degraded form
   * (tool results shortened, old turns dropped, or tools stopped early to stay
   * inside the model's context window). Several notices are joined with "\n".
   */
  notice?: string;
  contentPromotedFromReasoning?: boolean;
  /**
   * The person stopped this answer. Not an error: `content` is what arrived
   * before the stop. Messages stored before this field existed carry
   * `error: "Cancelled by client."` instead, and the client reads both the same.
   */
  stopped?: boolean;
  /** The person's 👍/👎 on this answer (assistant messages only). */
  feedback?: MessageFeedback;
  createdAt: string;
}

/** One answer's rating. Every change is also appended to the owner's feedback log (storage/feedbackStore.ts). */
export interface MessageFeedback {
  rating: "up" | "down";
  /** Optional short reason, given with a 👎. */
  reason?: string;
}

/**
 * What a conversation is made of. Fixed by its first message and never changed
 * afterwards: an embedding turn and a chat turn produce completely different
 * messages, and interleaving them makes a transcript nobody can read and a
 * sidebar entry that cannot be labelled. Absent on conversations created before
 * this existed, and on ones with no messages yet — both are treated as "not
 * decided yet".
 */
export type ConversationKind = "chat" | "embedding";

/**
 * One stored summary of a conversation's older turns, written the first time the
 * context window filled and rewritten (folding itself in) whenever it fills
 * again. Optional and additive: a conversation file written before this existed
 * loads unchanged and simply has no summary.
 *
 * `throughMessageId` is what makes it re-usable — it says which message the
 * summary covers up to, so a later turn sends the summary plus only the
 * messages after it. See chat/historySummary.ts.
 */
export interface HistorySummary {
  /** The summary itself, in Korean. Capped when written; never grows unbounded. */
  text: string;
  /** The last message of `Conversation.messages` this summary covers. */
  throughMessageId: string;
  /** How many messages from the start of the conversation it covers (index of `throughMessageId` + 1). */
  coveredMessages: number;
  createdAt: string;
  /** What the summary cost to generate, as the server reported it. */
  tokens?: number;
}

export interface Conversation {
  id: string;
  title: string;
  systemPrompt: string;
  /** Model id chosen for this conversation. Empty/unknown -> server default. */
  model?: string;
  kind?: ConversationKind;
  settings: ConversationSettings;
  enabledTools: string[];
  messages: StoredMessage[];
  /**
   * The older turns folded into prose once the window filled. Absent until
   * that happens, which for most conversations is never.
   */
  historySummary?: HistorySummary;
  /** 사이드바 맨 위 "고정됨" 묶음에 둔다. 고정한 적이 없으면 없다. */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** So the sidebar can mark embedding conversations without loading them. */
  kind?: ConversationKind;
  /** Only present (true) on a pinned conversation. */
  pinned?: boolean;
}
