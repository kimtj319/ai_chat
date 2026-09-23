import { flushSseBuffer, parseSseChunk } from "./sseParser";
import type {
  AddModelEndpointRequest,
  AddModelEndpointResponse,
  AdminGroup,
  AdminUser,
  AttachmentErrorCode,
  AuthErrorCode,
  AuthUser,
  Conversation,
  ConversationSummary,
  CreateConversationRequest,
  CreateMcpServerRequest,
  HealthResponse,
  McpHealth,
  McpServerSummary,
  McpServersResponse,
  McpToolSummary,
  MessageAttachment,
  ModelEndpointErrorCode,
  ModelEndpointsResponse,
  ModelsResponse,
  PatchConversationRequest,
  PatchMcpServerRequest,
  RagDocument,
  RagDocumentScope,
  RagDocumentsResponse,
  DocumentChunksResponse,
  UploadEvent,
  SendMessageRequest,
  ServerEvent,
  Session,
  SignupRequest,
  ToolDefinition,
  BoardListResponse,
  BoardPostStatus,
  BoardPostView,
} from "./types";

export class ApiError extends Error {}

/**
 * Every /api route except the auth ones answers 401 once the session is gone
 * (expired, logged out elsewhere, the account blocked mid-session). The app
 * shell registers a handler here so any such answer — from a plain request, an
 * upload, or the message stream — sends the user back to the login screen
 * instead of leaving a half-broken view behind.
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

/** An auth/admin refusal, carrying the server's own `code`. */
export class AuthError extends ApiError {
  readonly code: AuthErrorCode | null;
  readonly status: number;

  constructor(message: string, code: AuthErrorCode | null, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** An upload refusal, carrying the server's own `code` so the UI can pick the
 * Korean copy that names the right workaround. */
export class AttachmentError extends ApiError {
  readonly code: AttachmentErrorCode | null;

  constructor(message: string, code: AttachmentErrorCode | null) {
    super(message);
    this.code = code;
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    const message = body?.error ?? body?.message;
    if (message) return `${message} (${status})`;
  } catch {
    // Response body was not JSON (or already consumed) — fall through.
  }
  return `요청이 실패했습니다 (${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(`서버에 연결할 수 없습니다: ${message}`);
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(await extractErrorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function getSession(): Promise<Session> {
  return request<Session>("/session");
}

export function listConversations(): Promise<ConversationSummary[]> {
  return request<ConversationSummary[]>("/conversations");
}

export function createConversation(body: CreateConversationRequest): Promise<Conversation> {
  return request<Conversation>("/conversations", { method: "POST", body: JSON.stringify(body) });
}

export function getConversation(id: string): Promise<Conversation> {
  return request<Conversation>(`/conversations/${id}`);
}

export function patchConversation(id: string, patch: PatchConversationRequest): Promise<Conversation> {
  return request<Conversation>(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function deleteConversation(id: string): Promise<void> {
  await request<void>(`/conversations/${id}`, { method: "DELETE" });
}

/**
 * Ask the server to abort the in-flight turn for this conversation. Aborting
 * our own fetch is not enough on its own behind a reverse proxy, which can
 * hold the upstream connection open after the browser disconnects; this hits
 * the server directly. A 404 just means the turn already finished.
 */
export async function stopGeneration(id: string): Promise<void> {
  await request<void>(`/conversations/${id}/stream`, { method: "DELETE" });
}

/**
 * "지금 답변하기": ask the server to move the in-flight turn to a wrap-up
 * answer instead of cutting it off. Unlike stopGeneration, this does not touch
 * our own fetch — the SSE stream keeps running and finishes normally with the
 * wrap-up content. A 404 just means the turn already finished (or never
 * started); the caller treats that as harmless, the same way stopGeneration's
 * caller does.
 */
export async function answerNow(id: string): Promise<void> {
  await request<void>(`/conversations/${id}/answer-now`, { method: "POST" });
}

/** Path the browser fetches an attachment's bytes from (also an <img> src). */
export function attachmentUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${conversationId}/attachments/${attachmentId}`;
}

/**
 * Upload one prepared attachment. The body is the raw bytes with the file's
 * own Content-Type — images already downscaled, text already re-encoded to
 * UTF-8 — and the name rides in the query string so it survives non-ASCII.
 */
export async function uploadAttachment(
  conversationId: string,
  name: string,
  body: Blob,
  signal: AbortSignal,
): Promise<MessageAttachment> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${conversationId}/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": body.type || "application/octet-stream" },
      body,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AttachmentError(`서버에 연결할 수 없습니다: ${message}`, null);
  }

  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    let code: AttachmentErrorCode | null = null;
    let message: string | null = null;
    try {
      const parsed = (await response.json()) as { error?: string; code?: AttachmentErrorCode };
      code = parsed?.code ?? null;
      message = parsed?.error ?? null;
    } catch {
      // Not JSON — fall back to the status line below.
    }
    throw new AttachmentError(message ?? `요청이 실패했습니다 (${response.status})`, code);
  }

  return (await response.json()) as MessageAttachment;
}

export async function deleteAttachment(conversationId: string, attachmentId: string): Promise<void> {
  await request<void>(`/conversations/${conversationId}/attachments/${attachmentId}`, { method: "DELETE" });
}

/** A text attachment's content, fetched when a preview opens rather than held. */
export async function fetchAttachmentText(conversationId: string, attachmentId: string): Promise<string> {
  const response = await fetch(attachmentUrl(conversationId, attachmentId), { credentials: "include" });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(await extractErrorMessage(response));
  }
  return await response.text();
}

export function listDocuments(): Promise<RagDocumentsResponse> {
  return request<RagDocumentsResponse>("/documents");
}

/**
 * Upload one document for indexing.
 *
 * The body is the file's own bytes and the name rides in the query string, the
 * same way attachments travel, so a Korean filename survives. This request is
 * SLOW by nature — the engine embeds every chunk before it answers — so the
 * caller is expected to show that something is happening rather than to race it
 * with a short timeout.
 */
/**
 * 문서 하나를 올리고, 색인이 끝날 때까지 진행 상황을 받는다.
 *
 * 서버가 SSE 로 답하는 이유는 이 요청이 느리기 때문이다 — 글자를 꺼내고,
 * 모델에게 경계를 묻고, 청크마다 벡터를 만든다. `onEvent` 로 그 사이의
 * 단계가 올라오고, 한도를 넘는 문서는 서버가 나누므로 결과가 여러 건일 수
 * 있다.
 */
export async function uploadDocument(
  name: string,
  body: Blob,
  scope: RagDocumentScope,
  onEvent?: (event: UploadEvent) => void,
  signal?: AbortSignal,
): Promise<RagDocument[]> {
  const query = `name=${encodeURIComponent(name)}&scope=${scope}`;
  let response: Response;
  try {
    response = await fetch(`/api/documents?${query}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": body.type || "text/plain" },
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(`서버에 연결할 수 없습니다: ${message}`);
  }
  if (!response.ok) {
    // 스트림이 열리기 전의 실패 — 종류·크기 거절이 여기로 온다.
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(await extractErrorMessage(response));
  }
  if (!response.body) throw new ApiError("서버 응답을 읽을 수 없습니다.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let documents: RagDocument[] = [];
  let failure: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 는 빈 줄로 한 메시지가 끝난다.
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let event: UploadEvent;
      try {
        event = JSON.parse(line.slice(5).trim()) as UploadEvent;
      } catch {
        continue;
      }
      onEvent?.(event);
      if (event.type === "done") {
        documents = event.documents;
        if (event.error) failure = event.error;
      } else if (event.type === "failed") {
        failure = event.error;
      }
    }
  }

  // 색인까지 끝난 문서가 하나도 없으면 실패다. 일부만 실패한 경우는 문서를
  // 돌려주되 호출자가 알 수 있도록 예외 대신 결과로 전한다.
  if (documents.length === 0) throw new ApiError(failure ?? "업로드가 끝나지 않았습니다.");
  return documents;
}

export async function setDocumentScope(id: string, scope: RagDocumentScope): Promise<RagDocument> {
  const body = await request<{ document: RagDocument }>(`/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ scope }),
  });
  return body.document;
}

export async function retryDocument(id: string): Promise<RagDocument> {
  const body = await request<{ document: RagDocument }>(`/documents/${id}/retry`, { method: "POST" });
  return body.document;
}

export async function deleteDocument(id: string): Promise<void> {
  await request<void>(`/documents/${id}`, { method: "DELETE" });
}

/** 원문. 크기가 커서 JSON 이 아니라 평문으로 온다. */
export async function fetchDocumentText(id: string): Promise<string> {
  const response = await fetch(`/api/documents/${id}/text`, { credentials: "include" });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(await extractErrorMessage(response));
  }
  return response.text();
}

/** 색인된 그대로의 청크. 다시 자르는 것이 아니라 그때 저장해 둔 것을 읽는다. */
export function fetchDocumentChunks(id: string): Promise<DocumentChunksResponse> {
  return request<DocumentChunksResponse>(`/documents/${id}/chunks`);
}

export function listTools(): Promise<ToolDefinition[]> {
  return request<ToolDefinition[]>("/tools");
}

export function getModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>("/models");
}

/** A refused endpoint mutation, carrying the server's own `code`. */
export class ModelEndpointError extends ApiError {
  readonly code: ModelEndpointErrorCode | null;

  constructor(message: string, code: ModelEndpointErrorCode | null) {
    super(message);
    this.code = code;
  }
}

/** Header the server accepts on endpoint mutations when it is protected. */
const ADMIN_TOKEN_HEADER = "X-Model-Admin-Token";

async function endpointMutation<T>(init: RequestInit, adminToken: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Only sent when the operator actually supplied one.
  if (adminToken.length > 0) headers[ADMIN_TOKEN_HEADER] = adminToken;

  let response: Response;
  try {
    response = await fetch("/api/models/endpoints", { credentials: "include", headers, signal, ...init });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelEndpointError(`서버에 연결할 수 없습니다: ${message}`, null);
  }

  if (!response.ok) {
    let code: ModelEndpointErrorCode | null = null;
    let message: string | null = null;
    try {
      const parsed = (await response.json()) as { error?: string; code?: ModelEndpointErrorCode };
      code = parsed?.code ?? null;
      message = parsed?.error ?? null;
    } catch {
      // Not JSON — the status line below is all we have.
    }
    throw new ModelEndpointError(message ?? `요청이 실패했습니다 (${response.status})`, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listModelEndpoints(): Promise<ModelEndpointsResponse> {
  return request<ModelEndpointsResponse>("/models/endpoints");
}

export function addModelEndpoint(
  body: AddModelEndpointRequest,
  adminToken: string,
  signal?: AbortSignal,
): Promise<AddModelEndpointResponse> {
  return endpointMutation<AddModelEndpointResponse>(
    { method: "POST", body: JSON.stringify(body) },
    adminToken,
    signal,
  );
}

export async function deleteModelEndpoint(baseUrl: string, adminToken: string): Promise<void> {
  await endpointMutation<void>({ method: "DELETE", body: JSON.stringify({ baseUrl }) }, adminToken);
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

export interface SendMessageCallbacks {
  onEvent: (event: ServerEvent) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

function emitEvent(raw: string, callbacks: SendMessageCallbacks): void {
  let parsed: ServerEvent;
  try {
    parsed = JSON.parse(raw) as ServerEvent;
  } catch {
    // A malformed/partial JSON payload must not kill the rest of the stream.
    return;
  }
  try {
    callbacks.onEvent(parsed);
  } catch (error) {
    // Deliberately separate from the parse failure above, and deliberately
    // noisy. Folding the two together meant a handler that threw on every
    // single event looked exactly like a quiet stream: the UI rendered
    // nothing until the turn ended, with nothing in the console to explain it.
    console.error("[sse] event handler threw; continuing the stream", parsed.type, error);
  }
}

/**
 * POST a new message and stream the SSE response. This is a POST, not a
 * GET, so `EventSource` cannot be used — read the body as a stream instead
 * and feed it through the shared (unit-tested) SSE parser.
 */
export async function sendMessage(
  conversationId: string,
  body: SendMessageRequest,
  signal: AbortSignal,
  callbacks: SendMessageCallbacks,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      callbacks.onDone();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError(`서버에 연결할 수 없습니다: ${message}`);
    return;
  }

  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    callbacks.onError(await extractErrorMessage(response));
    return;
  }

  if (!response.body) {
    callbacks.onError("스트리밍 응답 본문을 받을 수 없습니다.");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;

      const text = decoder.decode(value, { stream: true });
      const result = parseSseChunk(buffer, text);
      buffer = result.remainder;

      for (const raw of result.events) emitEvent(raw, callbacks);
      if (result.done) {
        callbacks.onDone();
        return;
      }
    }

    const flushed = flushSseBuffer(buffer);
    for (const raw of flushed.events) emitEvent(raw, callbacks);
    callbacks.onDone();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      callbacks.onDone();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError(`스트림을 읽는 중 오류가 발생했습니다: ${message}`);
  }
}

// ---- Authentication & accounts ----
//
// These use their own fetch helper rather than `request()` for two reasons: a
// 401 here is an ordinary answer ("not signed in") rather than a session that
// just died, so it must not fire the global unauthorized handler and loop; and
// the refusal body carries a `code` the screens turn into Korean copy.

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthError(`서버에 연결할 수 없습니다: ${message}`, null, 0);
  }

  if (!response.ok) {
    let code: AuthErrorCode | null = null;
    let message: string | null = null;
    try {
      const parsed = (await response.json()) as { error?: string; code?: AuthErrorCode };
      code = parsed?.code ?? null;
      message = parsed?.error ?? null;
    } catch {
      // Not JSON — the status line below is all we have.
    }
    throw new AuthError(message ?? `요청이 실패했습니다 (${response.status})`, code, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The signed-in account, or null when there is no (usable) session. */
export async function getMe(): Promise<AuthUser | null> {
  try {
    // The route answers `{ user }`, the same envelope /auth/login and
    // /auth/signup use. Reading the body as the user itself leaves `status`
    // undefined, which the caller reads as "not signed in".
    const { user } = await authRequest<{ user: AuthUser }>("/auth/me");
    return user;
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Sign in, then read the account back. The contract only promises "200 +
 * session" for the login call itself, so who we are is asked for separately
 * rather than guessed from the login response body.
 *
 * The password is passed straight through to the request and never stored,
 * cached or logged here.
 */
export async function login(id: string, password: string): Promise<AuthUser> {
  await authRequest<unknown>("/auth/login", { method: "POST", body: JSON.stringify({ id, password }) });
  const me = await getMe();
  if (!me) throw new AuthError("로그인 상태를 확인하지 못했습니다.", null, 0);
  return me;
}

/** Request an account. It is created PENDING and cannot sign in yet. */
export async function signup(body: SignupRequest): Promise<void> {
  await authRequest<void>("/auth/signup", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Replace your own password. The account is taken from the session, so this can
 * only ever change the signed-in user's own password.
 *
 * Succeeding signs every OTHER browser of this account out; this one stays in,
 * so there is nothing to do with the session afterwards.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await authRequest<void>("/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function logout(): Promise<void> {
  await authRequest<void>("/auth/logout", { method: "POST" });
}

export function listAdminUsers(): Promise<AdminUser[]> {
  return authRequest<AdminUser[]>("/admin/users");
}

export type AdminUserAction = "approve" | "block" | "unblock";

/**
 * Remove an account and everything it owns. Irreversible — the caller is
 * responsible for having asked first.
 */
export async function deleteAdminUser(id: string): Promise<void> {
  await authRequest<void>(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listAdminGroups(): Promise<AdminGroup[]> {
  return authRequest<AdminGroup[]>("/admin/groups");
}

export function createAdminGroup(name: string): Promise<AdminGroup> {
  return authRequest<AdminGroup>("/admin/groups", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameAdminGroup(id: string, name: string): Promise<AdminGroup> {
  return authRequest<AdminGroup>(`/admin/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteAdminGroup(id: string): Promise<void> {
  await authRequest<void>(`/admin/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `null` takes the account out of whatever group it was in. */
export async function setAdminUserGroup(id: string, groupId: string | null): Promise<void> {
  await authRequest<unknown>(`/admin/users/${encodeURIComponent(id)}/group`, {
    method: "PUT",
    body: JSON.stringify({ groupId }),
  });
}

export async function updateUserStatus(id: string, action: AdminUserAction): Promise<void> {
  await authRequest<void>(`/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

// ---- MCP servers ----
//
// Their own fetch helper, like the auth and endpoint groups above, for one
// reason `request()` cannot serve: the status code has to survive. A 404 here
// means the routes are not deployed, which the library page renders as an
// empty library rather than as a failure the user is asked to act on, and a
// 409 on a delete carries how many people adopted the server.

export class McpError extends ApiError {
  readonly status: number;
  /** Only set on the 409 a registrant gets when others adopted the server. */
  readonly adoptedCount: number | null;

  constructor(message: string, status: number, adoptedCount: number | null = null) {
    super(message);
    this.status = status;
    this.adoptedCount = adoptedCount;
  }
}

async function mcpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(`서버에 연결할 수 없습니다: ${message}`, 0);
  }

  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    let message: string | null = null;
    let adoptedCount: number | null = null;
    try {
      const parsed = (await response.json()) as { error?: string; adoptedCount?: number };
      message = parsed?.error ?? null;
      adoptedCount = typeof parsed?.adoptedCount === "number" ? parsed.adoptedCount : null;
    } catch {
      // Not JSON — the status line below is all we have.
    }
    throw new McpError(message ?? `요청이 실패했습니다 (${response.status})`, response.status, adoptedCount);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listMcpServers(): Promise<McpServersResponse> {
  return mcpRequest<McpServersResponse>("/mcp/servers");
}

export function createMcpServer(body: CreateMcpServerRequest): Promise<{ server: McpServerSummary }> {
  return mcpRequest<{ server: McpServerSummary }>("/mcp/servers", { method: "POST", body: JSON.stringify(body) });
}

export async function updateMcpServer(id: string, patch: PatchMcpServerRequest): Promise<void> {
  await mcpRequest<unknown>(`/mcp/servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await mcpRequest<unknown>(`/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Take a server into (or out of) the signed-in user's own library. */
export function setMcpAdoption(id: string, adopted: boolean): Promise<{ adopted: string[] }> {
  return mcpRequest<{ adopted: string[] }>(`/mcp/servers/${encodeURIComponent(id)}/adoption`, {
    method: "PUT",
    body: JSON.stringify({ adopted }),
  });
}

/** Switch a server's tools on/off in the picker and in the model's prompt —
 *  same call for a builtin, a self-registered server or an adopted one. */
export function setMcpHidden(id: string, hidden: boolean): Promise<{ hidden: string[] }> {
  return mcpRequest<{ hidden: string[] }>(`/mcp/servers/${encodeURIComponent(id)}/hidden`, {
    method: "PUT",
    body: JSON.stringify({ hidden }),
  });
}

/** `null` clears it. The value is passed straight through and never stored here. */
export function setMcpCredential(id: string, credential: string | null): Promise<{ hasCredential: boolean }> {
  return mcpRequest<{ hasCredential: boolean }>(`/mcp/servers/${encodeURIComponent(id)}/credential`, {
    method: "PUT",
    body: JSON.stringify({ credential }),
  });
}

export function probeMcpServer(id: string): Promise<{ health: McpHealth; tools: McpToolSummary[] }> {
  return mcpRequest<{ health: McpHealth; tools: McpToolSummary[] }>(`/mcp/servers/${encodeURIComponent(id)}/probe`, {
    method: "POST",
  });
}

/** Administrator only: take a server out of service for everyone. */
export async function setMcpServerStatus(id: string, disabled: boolean, reason?: string): Promise<void> {
  await mcpRequest<unknown>(`/admin/mcp/servers/${encodeURIComponent(id)}/status`, {
    method: "PUT",
    body: JSON.stringify(reason ? { disabled, reason } : { disabled }),
  });
}


/* --------------------------------------------------------------- 문의 게시판 */

export function listBoardPosts(): Promise<BoardListResponse> {
  return request<BoardListResponse>("/board");
}

export function getBoardPost(id: string): Promise<{ post: BoardPostView }> {
  return request<{ post: BoardPostView }>(`/board/${encodeURIComponent(id)}`);
}

export function createBoardPost(input: { title: string; body: string; tags: string[] }): Promise<{ post: BoardPostView }> {
  return request<{ post: BoardPostView }>("/board", { method: "POST", body: JSON.stringify(input) });
}

export function replyToBoardPost(id: string, body: string): Promise<{ post: BoardPostView }> {
  return request<{ post: BoardPostView }>(`/board/${encodeURIComponent(id)}/replies`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function setBoardPostStatus(id: string, status: BoardPostStatus): Promise<{ post: BoardPostView }> {
  return request<{ post: BoardPostView }>(`/board/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function deleteBoardPost(id: string): Promise<void> {
  return request<void>(`/board/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 내 "하지 말 것" 목록. 서버 routes/prohibitions.ts. */
export interface ProhibitionsResponse {
  markdown: string;
  /** 대화에 반영되는 부분의 글자 수. */
  activeChars: number;
  limitChars: number;
  /** activeChars / limitChars 가 이 비율을 넘으면 정리를 권한다. */
  warnRatio: number;
  fileMaxChars: number;
  pendingCount: number;
}

export function getProhibitions(): Promise<ProhibitionsResponse> {
  return request<ProhibitionsResponse>("/prohibitions");
}

export function saveProhibitions(markdown: string): Promise<ProhibitionsResponse> {
  return request<ProhibitionsResponse>("/prohibitions", { method: "PUT", body: JSON.stringify({ markdown }) });
}

export function consolidateProhibitions(): Promise<{ proposal: string; before: number; after: number }> {
  return request("/prohibitions/consolidate", { method: "POST" });
}
