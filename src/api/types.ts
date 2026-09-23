// Types for the backend API contract. The backend owns conversations, system
// prompts, settings and runs the model call (including the tool-calling
// loop) — the client is a pure consumer of these shapes.

/**
 * Qwen3.8's effort ladder is low < medium < xhigh. There is no "high" — the
 * servers reject it outright — so the top level is "xhigh" everywhere.
 */
export type ReasoningLevel = "off" | "low" | "medium" | "xhigh";

/**
 * Conversations saved before the ladder was verified may still hold "high".
 * Fold those onto "xhigh" so the control shows the right option selected.
 */
export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  if (value === "off" || value === "low" || value === "medium" || value === "xhigh") return value;
  if (value === "high") return "xhigh";
  return "off";
}

/**
 * What happens when the model thinks for a long time.
 *
 * "external" lets it think to its own end, however long that takes — the
 * answer is whatever the model eventually arrives at. "normal" puts a ceiling
 * on it: past the deadline the server stops the generation and asks for the
 * answer to be written from the reasoning collected so far, so a turn always
 * ends with something rather than running unbounded.
 */
export type ReasoningMode = "normal" | "external";

/** Anything unrecognised (including a record written before modes existed) is "external". */
export function normalizeReasoningMode(value: unknown): ReasoningMode {
  return value === "normal" ? "normal" : "external";
}

export interface Session {
  sessionId: string;
  createdAt: string;
}

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

export interface ConversationSettings {
  reasoningLevel: ReasoningLevel;
  reasoningMode: ReasoningMode;
  thinkingTokenBudget: number;
  temperature: number;
  topP: number;
  maxTokens: number;
  presencePenalty: number;
  frequencyPenalty: number;
  seed: number | null;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** A tool's outcome as persisted on a message (full, untruncated result). */
export interface ToolResult {
  id: string;
  name: string;
  ok: boolean;
  /** 서버는 결과가 없는 경우 이 필드를 아예 빼고 보낸다. */
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

/** One stored attachment as the server reports it back. */
export interface MessageAttachment {
  id: string;
  kind: "image" | "text";
  name: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  estimatedTokens?: number;
  chars?: number;
  /** Whether the text was inlined into the prompt rather than referenced. */
  inlined?: boolean;
  createdAt: string;
}

/** The refusal codes an attachment upload can come back with. */
export type AttachmentErrorCode =
  | "too_large"
  | "unsupported_type"
  | "unsupported_document"
  | "undecodable_text"
  | "too_many"
  | "quota"
  | "rate_limited";

/**
 * An embedding turn's result. An embedding model does not answer — it returns
 * the vector for the text that was sent, so the assistant message carries this
 * instead of prose.
 */
export interface MessageEmbedding {
  /** The model that produced the vector, as the server resolved it. */
  model: string;
  /** Vector length, e.g. 1024 for a typical embedding model. */
  dimensions: number;
  vector: number[];
  /**
   * Cosine similarity against the previous embedding in the same
   * conversation. Absent (or null) for the first embedding of a conversation.
   */
  // 선택이 아니다. 서버는 첫 임베딩일 때 **생략이 아니라 null** 을 보낸다 —
  // "비교할 것이 없었다" 와 "직교한다" 는 다른 사실이고 화면이 다르게 보인다.
  cosineToPrevious: number | null;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** May be "" when the message carries attachments instead of text. */
  content: string;
  attachments?: MessageAttachment[];
  /** Present instead of `content` on an embedding model's answer. */
  embedding?: MessageEmbedding;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  usage?: MessageUsage;
  /** How long the server took to produce this answer, in milliseconds. */
  durationMs?: number;
  error?: string;
  /** Informational note about how the turn ran (not an error), e.g. a context-limit stop. */
  notice?: string;
  contentPromotedFromReasoning?: boolean;
  createdAt: string;
}

/**
 * What a conversation *is*. The first message locks it: a conversation started
 * against a chat model stays a chat conversation, one started against an
 * embedding model stays an embedding conversation, and the server refuses a
 * model of the other kind afterwards.
 */
export type ConversationKind = "chat" | "embedding";

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Absent on records written before kinds existed — read as "chat". */
  kind?: ConversationKind;
}

export interface Conversation {
  id: string;
  title: string;
  /** Absent on records written before kinds existed — read as "chat". */
  kind?: ConversationKind;
  systemPrompt: string;
  settings: ConversationSettings;
  enabledTools: string[];
  /** Which model this conversation talks to. "" means "use the server default". */
  model?: string;
  /** 오래된 앞부분을 요약으로 접었을 때의 기록. 접은 적이 없으면 없다. */
  historySummary?: HistorySummary;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationRequest {
  title?: string;
  systemPrompt?: string;
  model?: string;
}

export interface PatchConversationRequest {
  title?: string;
  systemPrompt?: string;
  settings?: ConversationSettings;
  enabledTools?: string[];
  model?: string;
}

export interface SendMessageRequest {
  /** May be "" when `attachmentIds` is present. */
  content: string;
  attachmentIds?: string[];
  settings?: ConversationSettings;
  enabledTools?: string[];
}

// A JSON-Schema-ish shape, just detailed enough to render tool parameters in
// a readable collapsed form without dumping raw JSON on screen.
export interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: Array<string | number | boolean>;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: string;
  parameters: JsonSchemaNode;
}

/**
 * The attachment ceilings the server derives from the model's own context
 * window. Published per model, because a conversation on a smaller model gets
 * a smaller budget — the client must never carry its own copy of these.
 */
export interface AttachmentLimits {
  /** The model's context window (`maxModelLen`), restated for convenience. */
  contextWindow: number;
  /** Attachment tokens one message may carry (server default: 25% of the window). */
  maxMessageTokens: number;
  /** Attachment tokens a single file may cost (server default: half of the above). */
  maxFileTokens: number;
  /** Byte ceiling for one uploaded attachment. */
  maxFileBytes: number;
  /** Stored-image dimension ceilings; the client downscales to fit them. */
  maxImageWidth: number;
  maxImageHeight: number;
}

/**
 * What a served model can actually do, as the backend classifies it.
 * - "chat"      normal conversation
 * - "embedding" text in, vector out — no answer to read
 * - "rerank"    needs a query *and* a document list, so a chat composer
 *               cannot drive it at all
 * - "unusable"  served but not usable from this app
 */
export type ModelCapability = "chat" | "embedding" | "rerank" | "unusable";

/** One model's catalog entry: which endpoint serves it and its context window. */
export interface ModelCatalogEntry {
  id: string;
  endpoint: string;
  /** Absent from an older backend — read as "chat". */
  capability?: ModelCapability;
  /** The configured URL verbatim, e.g. "http://10.0.0.2:30023/v1". */
  baseUrl?: string;
  /** False when the server could not reach this endpoint on its last check. */
  reachable?: boolean;
  /**
   * True when the model ignores the reasoning controls outright, so the picker
   * must not offer levels it will not honour. Absent from an older backend —
   * read as adjustable, never as fixed.
   */
  reasoningFixed?: boolean;
  maxModelLen: number;
  /**
   * Present once the server publishes its derived ceilings. Read through
   * `attachmentLimitsFor()`, which also accepts the same numbers hoisted onto
   * the entry and falls back to the documented shares when they are absent.
   */
  attachments?: Partial<Omit<AttachmentLimits, "contextWindow">>;
}

/** One serving endpoint as `GET /api/models/endpoints` reports it. */
export interface ModelEndpoint {
  label: string;
  baseUrl: string;
  /** "env" entries are fixed by deployment and cannot be removed from the UI. */
  source: "file" | "env";
  reachable: boolean;
  models: string[];
  maxModelLen: number;
  latencyMs: number;
}

export interface ModelEndpointsResponse {
  /** True when the server has no admin token configured — anyone can mutate. */
  unprotected: boolean;
  endpoints: ModelEndpoint[];
}

export interface AddModelEndpointRequest {
  label?: string;
  baseUrl: string;
  /** The serving server's own key. Optional, and not verifiable (see the UI copy). */
  apiKey?: string;
}

export interface AddModelEndpointResponse {
  label: string;
  baseUrl: string;
  models: string[];
  maxModelLen: number;
}

export type ModelEndpointErrorCode =
  | "invalid_url"
  | "unreachable"
  | "not_vllm"
  | "duplicate"
  | "forbidden"
  | "write_failed";

export interface ModelsResponse {
  models: string[];
  current: string;
  catalog: ModelCatalogEntry[];
}

export interface HealthResponse {
  backend: "ok";
  vllm: "ok" | "unreachable";
  model?: string;
  latencyMs?: number;
}

// SSE event stream emitted by POST /api/conversations/:id/messages.
export type ServerEvent =
  | { type: "user_message"; message: ChatMessage }
  /**
   * Sent once, right after `user_message`, for a chat turn only (not an
   * embedding). `startedAt` is the server's own clock (ms since epoch) for
   * when this turn began — the basis for the "지금 답변하기" button's 3-minute
   * mark, so the client is not timing against its own Date.now() (request
   * latency, clock skew). `answerNowAfterMs` is that mark, from the server's
   * own config, so a deployment that changes it does not also need a client
   * rebuild.
   */
  | { type: "turn_started"; startedAt: number; answerNowAfterMs: number }
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; durationMs: number; preview: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "notice"; message: string }
  /** The conversation was renamed from a summary of the request that opened it. */
  | { type: "title"; title: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string };

// ---- Authentication & accounts ----
//
// Added when the app grew a real login. Every /api route except the /auth ones
// answers 401 when there is no session, so these shapes gate the whole UI.

/** What an account is allowed to do. Anything else is treated as "user". */
export type UserRole = "user" | "admin";

/**
 * Where an account sits in its lifecycle. Signup creates a "pending" account
 * that cannot log in until an administrator approves it.
 */
export type AccountStatus = "pending" | "active" | "blocked";

/** The signed-in account, as `GET /api/auth/me` reports it. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: AccountStatus;
}

/** One row of `GET /api/admin/users`. */
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  status: AccountStatus;
  createdAt: string;
  role?: "user" | "admin";
  /** The group this account is filed under; absent means "no group". */
  groupId?: string;
}

/** One admin-created group. A label for sorting accounts, nothing more. */
export interface AdminGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface SignupRequest {
  id: string;
  name: string;
  email: string;
  password: string;
}

/** The refusal codes the auth and admin routes can come back with. */
export type AuthErrorCode =
  | "invalid_credentials"
  | "pending_approval"
  | "blocked"
  | "duplicate_id"
  | "weak_password"
  | "same_password"
  | "cannot_delete_self"
  | "duplicate_group"
  | "not_admin"
  | "invalid_input"
  | "unauthorized"
  // 서버가 실제로 돌려주는데 여기 없던 것들. 없으면 화면이 이 상황을
  // 아무 설명 없는 오류로 보여 준다 — 특히 rate_limited 는 로그인 제한이라
  // 사용자가 "왜 안 되지" 로 겪는 자리다. (contract.check.ts 가 잡아냈다)
  | "not_found"
  | "rate_limited"
  | "cannot_block_self";

// ---- MCP servers (the 라이브러리 page) ----
//
// A registered MCP server is a set of tools the backend can call on a user's
// behalf. Two things about the shape matter to the client: a server another
// user registered does nothing for you until you adopt it, and every tool it
// publishes arrives with the full name a conversation stores.

export type McpOrigin = "builtin" | "user";

/** "disabled" is an administrator's doing; the owner cannot set it. */
export type McpServerStatus = "active" | "disabled";

/** "header" sends one credential header the registrant (or adopter) supplies. */
export type McpAuthMode = "none" | "header";

export type McpHealthState = "unknown" | "ok" | "degraded" | "down" | "quarantined";

export interface McpHealth {
  state: McpHealthState;
  checkedAt?: string;
  /** Why the last probe failed. Shown verbatim — it is the only thing that
   *  tells an adopter whether the failure is theirs to fix. */
  error?: string;
  toolCount?: number;
}

export interface McpToolSummary {
  /** The full name a conversation stores: `mcp__{slug}__{tool}`. */
  name: string;
  /**
   * The tool's own description. It sits in the prompt of every conversation
   * this tool is switched on in, called or not, which is why the library page
   * shows it in full rather than behind a disclosure.
   */
  description: string;
}

/**
 * One uploaded document, as the 문서 page shows it.
 *
 * `scope` is per document, not per account: publishing one must not publish the
 * rest. `chunks` is how many pieces it was cut into — shown because it is the
 * only visible sign of how much of the prompt this document can occupy.
 */
export type RagDocumentScope = "private" | "shared";

export interface RagDocument {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  chars: number;
  chunks: number;
  /** 경계를 모델이 골랐는지 규칙이 골랐는지. 목록에서 구별해 보여 준다. */
  chunkedBy: "llm" | "rule";
  scope: RagDocumentScope;
  status: "ready" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 공개 문서 한 건에 등록자를 붙인 모양. 문서 페이지의 '전체 공개' 목록이 쓴다. */
export interface SharedRagDocument extends RagDocument {
  ownerId: string;
  /** 계정이 지워졌으면 null. */
  ownerName: string | null;
}

/** 업로드 중 서버가 흘려보내는 것들. 진행 막대와 알림의 근거다. */
export type UploadEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "split"; total: number; message: string }
  | { type: "part"; index: number; total: number; name: string; message: string }
  | { type: "chunks"; index: number; indexed: number; total: number; message: string }
  | { type: "indexed"; index: number; total: number; document: RagDocument }
  | { type: "done"; documents: RagDocument[]; error?: string }
  | { type: "failed"; code: string; error: string };

export interface DocumentChunk {
  text: string;
  /** 앞 청크에서 이월된 머리 글자 수. `text.slice(0, overlapLen)` 이 겹침이다. */
  overlapLen: number;
}

export interface DocumentChunksResponse {
  chunks: DocumentChunk[];
  chunkedBy: "llm" | "rule";
}

export interface RagDocumentsResponse {
  /** False when the server has no engine configured — the page says so instead of failing per action. */
  enabled: boolean;
  maxBytes: number;
  /** 내가 올린 것 전부 — 공개 여부와 무관하다. */
  documents: RagDocument[];
  /**
   * 누가 올렸든, 전체 공개된 것 전부. 등록자가 함께 온다.
   *
   * 내가 공개한 문서는 양쪽에 다 들어간다. 겹치는 것이 맞다 — 위는 "모두가
   * 검색하는 것", 아래는 "내가 올린 것" 으로 묻는 질문이 다르다.
   */
  shared: SharedRagDocument[];
}

export interface McpServerSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  url: string;
  /** The host requests actually go to, as the server resolved it. */
  host: string;
  /** 서버가 보내는 값은 "http" 하나다. string 으로 열어 두면 없는 값을 다루는 코드가 생긴다. */
  transport: "http";
  origin: McpOrigin;
  status: McpServerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** How many people took this into their own library. */
  adoptedCount: number;
  authMode: McpAuthMode;
  authHeaderName?: string;
  /** Whether this server needs a credential of its own from each user. */
  requiresCredential: boolean;
  /** Whether the signed-in user has one stored for it. */
  hasCredential: boolean;
  health: McpHealth;
  tools: McpToolSummary[];
  /** 관리자가 끌 때 남긴 이유. 없을 수 있다. */
  disabledReason?: string;
}

export interface McpServersResponse {
  servers: McpServerSummary[];
  /** Ids of the user-registered servers this user took into their library. */
  adopted: string[];
  /** Ids of any server (builtin, self-registered or adopted) this user switched off. */
  hidden: string[];
}

export interface CreateMcpServerRequest {
  name: string;
  slug: string;
  description: string;
  url: string;
  authMode: McpAuthMode;
  authHeaderName?: string;
  credential?: string;
}

export type PatchMcpServerRequest = Partial<CreateMcpServerRequest>;


/* --------------------------------------------------------------- 문의 게시판 */

export type BoardPostStatus = "open" | "closed";

export interface BoardReply {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface BoardReplyView extends BoardReply {
  /** 계정이 지워졌으면 null — 화면은 id 를 대신 쓴다. */
  authorName: string | null;
}

/** 글 하나의 전체. 본문과 답변이 함께 온다. */
export interface BoardPostView {
  id: string;
  title: string;
  body: string;
  tags: string[];
  status: BoardPostStatus;
  authorId: string;
  authorName: string | null;
  replies: BoardReplyView[];
  createdAt: string;
  updatedAt: string;
  closedBy?: string;
  closedAt?: string;
  /** 지금 보는 사람이 상태를 바꾸거나 지울 수 있는가. 서버가 판단해서 보낸다. */
  canManage: boolean;
}

/** 목록용. 본문과 답변 내용은 빠지고 답변 수만 온다. */
export interface BoardPostSummary {
  id: string;
  title: string;
  tags: string[];
  status: BoardPostStatus;
  authorId: string;
  authorName: string | null;
  replyCount: number;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardListResponse {
  /** 열림·닫힘을 **가르지 않고** 전부 온다 — 탭마다 건수를 보여 줘야 하기 때문이다. */
  posts: BoardPostSummary[];
  /** 지금 쓰이고 있는 태그 전부. 새 글을 쓸 때 고르게 한다. */
  tags: string[];
}
