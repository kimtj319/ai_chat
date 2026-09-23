// Shared types for the API contract. Keep in sync with the frontend contract —
// field names here are load-bearing (the frontend is built against them).

/**
 * Qwen3.8's effort ladder is low < medium < xhigh; there is no "high" — the
 * servers reject it with HTTP 400 (measured 2026-09-11 on both endpoints).
 * "high" is still accepted when reading older stored conversations and is
 * normalised to "xhigh"; see normalizeReasoningLevel.
 */
export type ReasoningLevel = "off" | "low" | "medium" | "xhigh";

/** Coerce any stored/incoming value to a level the servers accept. */
export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  if (value === "low" || value === "medium" || value === "xhigh" || value === "off") return value;
  if (value === "high") return "xhigh"; // legacy value from before the ladder was verified
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

/**
 * Check a settings patch before it is stored.
 *
 * Without this the PATCH route spread whatever arrived straight onto the
 * conversation, and the values it stored went to vLLM on the next turn. That
 * made a conversation permanently unusable from one bad request — measured on
 * the deployment: `seed: "abc"` produced
 * "Input should be a valid integer, unable to parse string as an integer" and
 * `topP: 99` produced "top_p must be in (0, 1], got 99.0", on every later turn,
 * with no way to recover from the UI because the UI never sends those values.
 *
 * Out-of-range is refused rather than clamped: a number silently changed to
 * something else is the same surprise in a quieter form, and the caller who
 * sent 99 wants to know that 99 is not a top_p.
 */
export interface SettingsPatchProblem {
  field: string;
  message: string;
}

const SETTINGS_BOUNDS = {
  thinkingTokenBudget: { min: 0, max: 65536, integer: true },
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false, exclusiveMin: true },
  maxTokens: { min: 1, max: 65536, integer: true },
  presencePenalty: { min: -2, max: 2, integer: false },
  frequencyPenalty: { min: -2, max: 2, integer: false },
} as const;

export function validateSettingsPatch(
  input: Record<string, unknown>,
): { ok: true; value: Partial<ConversationSettings> } | { ok: false; problem: SettingsPatchProblem } {
  const value: Partial<ConversationSettings> = {};

  if (input.reasoningLevel !== undefined) value.reasoningLevel = normalizeReasoningLevel(input.reasoningLevel);
  if (input.reasoningMode !== undefined) value.reasoningMode = normalizeReasoningMode(input.reasoningMode);

  for (const [field, bound] of Object.entries(SETTINGS_BOUNDS)) {
    const raw = input[field];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, problem: { field, message: `${field}은(는) 숫자여야 합니다.` } };
    }
    if (bound.integer && !Number.isInteger(raw)) {
      return { ok: false, problem: { field, message: `${field}은(는) 정수여야 합니다.` } };
    }
    const tooSmall = "exclusiveMin" in bound && bound.exclusiveMin ? raw <= bound.min : raw < bound.min;
    if (tooSmall || raw > bound.max) {
      const low = "exclusiveMin" in bound && bound.exclusiveMin ? `${bound.min} 초과` : `${bound.min} 이상`;
      return { ok: false, problem: { field, message: `${field}은(는) ${low} ${bound.max} 이하여야 합니다.` } };
    }
    (value as Record<string, number>)[field] = raw;
  }

  if (input.seed !== undefined) {
    // null is "let the server pick", which is the default and not an error.
    if (input.seed === null) value.seed = null;
    else if (typeof input.seed === "number" && Number.isSafeInteger(input.seed)) value.seed = input.seed;
    else return { ok: false, problem: { field: "seed", message: "seed은(는) 정수이거나 null이어야 합니다." } };
  }

  // Anything else the caller sent is dropped rather than stored: an unknown key
  // reaching vLLM is exactly the failure this function exists to prevent.
  return { ok: true, value };
}

export const DEFAULT_SETTINGS: ConversationSettings = {
  reasoningLevel: "off",
  reasoningMode: "external",
  /**
   * ~34 seconds of thinking before the answer starts, at the decode rate this
   * deployment actually runs at.
   *
   * Measured on the 27B (H200 x1): one stream decodes at 62.9 tok/s and eight
   * concurrent streams still get 59.8 tok/s each — 478 tok/s aggregate, a 5%
   * per-stream loss. Eight people sharing the model therefore do not slow each
   * other down much; what they each wait on is their own budget divided by
   * ~60 tok/s. The old 4096 was 68 seconds of silence before a single word.
   *
   * The budget is real, not advisory: 512 produced 568 characters of thinking
   * in 22.7s and 8192 produced 8,577 in 95.2s on the same question.
   */
  thinkingTokenBudget: 2048,
  temperature: 0.7,
  topP: 0.8,
  maxTokens: 16384,
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: null,
};

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
  createdAt: string;
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
}

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  /**
   * The account this browser session is signed in as. Absent = signed out.
   * The session cookie itself is unchanged by login: it identifies the browser,
   * and this field is what makes it an authenticated session.
   */
  userId?: string;
  loggedInAt?: string;
}

/**
 * pending  — registered, waiting for an admin. Cannot sign in.
 * active   — approved. The only status that can sign in.
 * blocked  — approved once, then blocked. Cannot sign in, and any session it
 *            already owns stops working on its very next request (the status is
 *            read from disk per request, never cached).
 */
export type UserStatus = "pending" | "active" | "blocked";
export type UserRole = "user" | "admin";

/**
 * One account, stored at {DATA_DIR}/auth/users/{id}.json.
 * `passwordHash` is the whole self-describing scrypt string (auth/password.ts);
 * the password itself is never stored, never logged and never returned.
 */
export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  /** Who approved/blocked/unblocked last, for the admin list. */
  statusChangedBy?: string;
  statusChangedAt?: string;
  /**
   * The group this account is filed under, or absent for "no group". A plain
   * id rather than a list: a group here is a folder an admin sorts accounts
   * into, not a permission, so one place per account is the whole model.
   */
  groupId?: string;
}

/** One group: a name an admin can file accounts under. Carries no privileges. */
export interface GroupRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** What the API returns about an account — everything except the hash. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  role: UserRole;
  createdAt: string;
  statusChangedBy?: string;
  statusChangedAt?: string;
  groupId?: string;
}

export function toPublicUser(user: UserRecord): PublicUser {
  const { passwordHash: _never, updatedAt: _unused, ...rest } = user;
  return rest;
}

/**
 * Machine-readable reason on every auth refusal, so the UI picks its own Korean
 * wording instead of matching on prose. `invalid_credentials` is deliberately
 * returned for both a wrong password and an unknown id — see routes/auth.ts.
 */
export type AuthErrorCode =
  | "invalid_credentials"
  | "pending_approval"
  | "blocked"
  | "duplicate_id"
  | "weak_password"
  // The new password is the one already in use, so the change would be a no-op.
  | "same_password"
  | "invalid_input"
  // 401. Named for the HTTP status, and matching the literal the frontend's
  // own AuthErrorCode union was built against (src/api/types.ts).
  | "unauthorized"
  | "not_admin"
  | "not_found"
  | "rate_limited"
  | "cannot_block_self"
  // Deleting your own account would lock the deployment out of its own
  // administration, and is the only guard needed: an admin cannot be the last
  // one AND be deleted by someone else at the same time.
  | "cannot_delete_self"
  | "duplicate_group";

/** Refusals that come from the model's measured capability, not from auth. */
export type ModelKindErrorCode = "rerank_unsupported" | "capability_mismatch" | "embedding_no_attachments";

/**
 * MCP (Model Context Protocol) integration.
 *
 * TRANSPORT: remote HTTP only — "streamable HTTP", the 2025-06-18 transport,
 * where every JSON-RPC request is one POST whose response is either a JSON body
 * or an SSE stream. stdio/npx servers are deliberately NOT supported: the
 * deployment runs this app as root with host networking and no resource limits,
 * so "register a server" would be "run an arbitrary command as root". The
 * `transport` field is stored anyway so that adding another one later is a new
 * value, not a migration of every record.
 */
export type McpTransport = "http";

/** "none" sends no credential; "header" sends `{authHeaderName}: {credential}`. */
export type McpAuthMode = "none" | "header";

/** builtin — seeded by the server at boot; user — registered through the API. */
export type McpServerOrigin = "builtin" | "user";

export type McpServerStatus = "active" | "disabled";

/**
 * unknown     — never probed since this process started.
 * ok          — initialize + tools/list succeeded.
 * degraded    — answered, but with no usable tool (empty list, or every tool
 *               dropped by the name/schema caps).
 * down        — unreachable, or answered with an error, fewer than 3 times running.
 * quarantined — 3 consecutive failures; no tools are offered and the next probe
 *               is 30 minutes away (discovery.ts).
 */
export type McpHealthState = "unknown" | "ok" | "degraded" | "down" | "quarantined";

/**
 * ONE uploaded document, at {DATA_DIR}/owners/{ownerId}/documents/{id}.json,
 * with its source text beside it as {id}.txt.
 *
 * `chunks` is written BEFORE the chunks reach the engine, not after. It is the
 * only record of what to clean up if indexing stops halfway, and a count
 * written afterwards would be missing in exactly the case it is needed.
 *
 * `scope` is what the reader sees, and it is the document's own property rather
 * than the owner's: publishing one document must not publish the rest.
 */
export type RagDocumentScope = "private" | "shared";

export interface RagDocument {
  id: string;
  /** As uploaded, after sanitising. Shown in the list and indexed as the chunk title. */
  name: string;
  mime: string;
  /** Source bytes, before chunking. */
  bytes: number;
  chars: number;
  chunks: number;
  /** Who chose the chunk boundaries: the model, or the rules. */
  chunkedBy: "llm" | "rule";
  scope: RagDocumentScope;
  /** "ready" once the engine has it; "failed" if it does not, with the reason. */
  status: "ready" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 공개 문서 한 건에 **누가 올렸는지**를 붙인 모양. 목록 응답에만 쓰인다.
 *
 * RagDocument 에 소유자를 넣지 않는 이유: 그건 파일이 어디에 놓였는지가 이미
 * 말해 주는 사실이고, 따로 적어 두면 둘이 어긋날 수 있다. 읽을 때 만든다.
 */
/* --------------------------------------------------------------- 문의 게시판 */

export type BoardPostStatus = "open" | "closed";

/** 글 하나에 달린 답변. 글 파일 안에 함께 산다 — 항상 같이 읽히기 때문이다. */
export interface BoardReply {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

/**
 * 문의 글. 저장되는 모양이다.
 *
 * 작성자는 id 만 담는다. 이름은 계정이 바뀌면 따라 바뀌어야 하므로 읽을 때
 * 붙인다 — 문서 목록이 등록자를 다루는 방식과 같다.
 */
export interface BoardPost {
  id: string;
  title: string;
  body: string;
  /** 사용자가 자유롭게 적는다. 소문자로 모으고 중복을 없앤 뒤 저장한다. */
  tags: string[];
  status: BoardPostStatus;
  authorId: string;
  replies: BoardReply[];
  createdAt: string;
  updatedAt: string;
  /** 누가 언제 닫았는가. 다시 열면 지운다. */
  closedBy?: string;
  closedAt?: string;
}

/** 화면에 나가는 모양 — 작성자 이름이 붙고, 목록에서는 본문과 답변이 빠진다. */
export interface BoardReplyView extends BoardReply {
  authorName: string | null;
}

export interface BoardPostView extends Omit<BoardPost, "replies"> {
  authorName: string | null;
  replies: BoardReplyView[];
  /** 지금 보는 사람이 이 글의 상태를 바꾸거나 지울 수 있는가. 화면이 묻지 않아도 되게. */
  canManage: boolean;
}

export interface BoardPostSummary
  extends Omit<BoardPost, "replies" | "body" | "closedBy" | "closedAt"> {
  authorName: string | null;
  replyCount: number;
  canManage: boolean;
}

export type BoardErrorCode = "invalid_input" | "not_found" | "forbidden";

export interface SharedRagDocument extends RagDocument {
  ownerId: string;
  /** 계정이 지워졌으면 null. 없는 이름을 지어내지 않는다. */
  ownerName: string | null;
}

export interface McpHealth {
  state: McpHealthState;
  checkedAt?: string;
  error?: string;
  toolCount?: number;
}

/**
 * ONE MCP server, at {DATA_DIR}/mcp/servers/{id}.json.
 *
 * The registry is GLOBAL and every signed-in account can read all of it, so it
 * holds NO SECRET — a credential lives in the adopting owner's own file
 * (mcp/ownerPrefs.ts) and never here, never in a response and never in a log.
 * The one exception is a builtin whose server authenticates by query parameter
 * instead of by header (Alpha Vantage): its key can only live inside `url`,
 * which is why routes/mcp.ts strips the query from every summary it builds.
 *
 * `slug` is immutable because it is inside the tool name the model is given
 * (`mcp__{slug}__{tool}`) and that name is what conversations have already
 * stored in their tool calls; renaming it would rewrite history.
 */
export interface McpServerRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  transport: McpTransport;
  /** https only. */
  url: string;
  origin: McpServerOrigin;
  status: McpServerStatus;
  authMode: McpAuthMode;
  authHeaderName?: string;
  /**
   * The tool names this server may contribute; absent or empty means all of
   * them. Set in code on a builtin definition only (mcp/registryStore.ts) and
   * accepted by no route: it is how a server that offers 133 tools costs the
   * prompt sixteen instead.
   */
  toolAllowlist?: string[];
  /**
   * Send the signed-in owner's id to this server, so it can answer as that
   * person rather than as one shared account.
   *
   * Set in code on a builtin definition only (mcp/registryStore.ts) and
   * accepted by no route, for the same reason `toolAllowlist` is — except that
   * here the cost of a mistake is not a missing tool but WHO EVERY USER IS,
   * handed to whichever endpoint the record happens to point at. A first-party
   * server we ship the address of can be told; something an admin typed into a
   * form cannot.
   */
  sendUserIdentity?: boolean;
  /** Clamped to 1000..9000 on write, so it always stays under TOOL_TIMEOUT_MS. */
  timeoutMs: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  disabledBy?: string;
  disabledAt?: string;
  disabledReason?: string;
}

/** One tool as the server described it, after sanitisation (mcp/toolAdapter.ts). */
export interface McpToolSummary {
  name: string;
  description: string;
}

/** What GET /api/mcp/servers returns per server, for the CALLING owner. */
export interface McpServerSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  url: string;
  /** `new URL(url).host` — what the UI shows without re-parsing the URL. */
  host: string;
  transport: McpTransport;
  origin: McpServerOrigin;
  status: McpServerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  adoptedCount: number;
  authMode: McpAuthMode;
  authHeaderName?: string;
  requiresCredential: boolean;
  /** Whether THIS owner has stored a credential. Never the value. */
  hasCredential: boolean;
  health: McpHealth;
  tools: McpToolSummary[];
  disabledReason?: string;
}

/**
 * One owner's MCP preferences, at {DATA_DIR}/owners/{ownerId}/mcp.json.
 *
 * `adopted` holds user-origin server ids the owner took into their library
 * (the "담기" checkbox on a server someone else shared) — it says nothing about
 * whether that server's tools currently run in a conversation.
 *
 * `hidden` is the on/off switch for tool availability, and applies to ANY
 * server the owner's library holds — builtin, self-registered or adopted
 * alike. This is the field the picker and the model both read (see
 * mcp/ownerPrefs.ts `effectiveServers` and src/mcp/rules.ts `isMcpVisible`,
 * which must agree). It replaces the old `optedOutBuiltins`, which only ever
 * covered builtins; `ownerPrefs.ts` still reads that old field name out of a
 * file written before this change, so nobody's saved preference is lost.
 */
export interface OwnerMcpPrefs {
  adopted: string[];
  hidden: string[];
  /** serverId -> credential. The only place a credential is ever written. */
  credentials: Record<string, string>;
}

/** Machine-readable refusal reason on the /api/mcp routes. */
export type McpErrorCode =
  | "invalid_input"
  | "duplicate_name"
  | "duplicate_slug"
  | "slug_immutable"
  | "not_found"
  | "forbidden"
  | "in_use"
  | "probe_failed";
