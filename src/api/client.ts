import { errorMessage } from "../state/friendlyError";
import { apiPath } from "./base";
import { ApiError, extractErrorMessage, notifyUnauthorized, readErrorBody, request } from "./http";
import { flushSseBuffer, parseSseChunk } from "./sseParser";
import type {
  Notice,
  NoticesResponse,
  ProbeModelEndpointResponse,
  AddModelEndpointRequest,
  AddModelEndpointResponse,
  AttachmentErrorCode,
  Conversation,
  ConversationSummary,
  CreateConversationRequest,
  HealthResponse,
  MessageAttachment,
  ModelEndpointErrorCode,
  ModelEndpointsResponse,
  ModelsResponse,
  CompactionStatusResponse,
  MyAccess,
  PersonalKeyName,
  PatchConversationRequest,
  ProhibitionsResponse,
  RagDocument,
  RagDocumentScope,
  RagDocumentsResponse,
  DocumentChunksResponse,
  ScheduledTask,
  SharedConversation,
  UploadEvent,
  Session,
  ToolDefinition,
  BoardListResponse,
  BoardPostStatus,
  BoardPostView,
} from "./types";

// The client is split by domain (http, stream, auth, mcp); everything stays
// importable from here.
export { ApiError, setUnauthorizedHandler } from "./http";
export * from "./stream";
export * from "./auth";
export * from "./mcp";
export type { ProhibitionsResponse, ScheduledTask, SharedConversation } from "./types";

/** An upload refusal, carrying the server's own `code` so the UI can pick the
 * Korean copy that names the right workaround. */
export class AttachmentError extends ApiError {
  readonly code: AttachmentErrorCode | null;

  constructor(message: string, code: AttachmentErrorCode | null) {
    super(message);
    this.code = code;
  }
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
  return apiPath(`/conversations/${conversationId}/attachments/${attachmentId}`);
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
    response = await fetch(apiPath(`/conversations/${conversationId}/attachments?name=${encodeURIComponent(name)}`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": body.type || "application/octet-stream" },
      body,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AttachmentError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`, null);
  }

  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    const body = await readErrorBody(response);
    // Not JSON — fall back to the status line.
    throw new AttachmentError(body.error ?? `요청이 실패했습니다 (${response.status})`, body.code as AttachmentErrorCode | null);
  }

  return (await response.json()) as MessageAttachment;
}

export async function deleteAttachment(conversationId: string, attachmentId: string): Promise<void> {
  await request<void>(`/conversations/${conversationId}/attachments/${attachmentId}`, { method: "DELETE" });
}

export function listDocuments(): Promise<RagDocumentsResponse> {
  return request<RagDocumentsResponse>("/documents");
}

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
    response = await fetch(apiPath(`/documents?${query}`), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": body.type || "text/plain" },
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`);
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

  const handle = (raw: string) => {
    let event: UploadEvent;
    try {
      event = JSON.parse(raw) as UploadEvent;
    } catch {
      return;
    }
    onEvent?.(event);
    if (event.type === "done") {
      documents = event.documents;
      if (event.error) failure = event.error;
    } else if (event.type === "failed") {
      failure = event.error;
    }
  };

  // SSE 는 빈 줄로 한 메시지가 끝난다. 나누기는 대화 스트림과 같은 파서가 한다
  // (서버는 [DONE] 을 보내지 않고 연결을 닫는다).
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const result = parseSseChunk(buffer, decoder.decode(value, { stream: true }));
    buffer = result.remainder;
    for (const raw of result.events) handle(raw);
  }
  for (const raw of flushSseBuffer(buffer).events) handle(raw);

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
  const response = await fetch(apiPath(`/documents/${id}/text`), { credentials: "include" });
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

async function endpointMutation<T>(init: RequestInit, adminToken: string, signal?: AbortSignal, subpath = ""): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Only sent when the operator actually supplied one.
  if (adminToken.length > 0) headers[ADMIN_TOKEN_HEADER] = adminToken;

  let response: Response;
  try {
    response = await fetch(apiPath(`/models/endpoints${subpath}`), { credentials: "include", headers, signal, ...init });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ModelEndpointError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`, null);
  }

  if (!response.ok) {
    // These routes are never public: a 401 means the session died.
    if (response.status === 401) notifyUnauthorized();
    const body = await readErrorBody(response);
    // Not JSON — the status line is all we have.
    throw new ModelEndpointError(body.error ?? `요청이 실패했습니다 (${response.status})`, body.code as ModelEndpointErrorCode | null);
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

/** The models a server offers, without adding it (for the chooser). */
export function probeModelEndpoint(
  body: { baseUrl: string; apiKey?: string },
  adminToken: string,
  signal?: AbortSignal,
): Promise<ProbeModelEndpointResponse> {
  return endpointMutation<ProbeModelEndpointResponse>({ method: "POST", body: JSON.stringify(body) }, adminToken, signal, "/probe");
}

/** Limit an already-registered endpoint to these models ([] = all). */
export function setModelEndpointModels(baseUrl: string, models: string[], adminToken: string): Promise<{ baseUrl: string; allowedModels: string[] | null }> {
  return endpointMutation({ method: "PATCH", body: JSON.stringify({ baseUrl, models }) }, adminToken);
}

export async function deleteModelEndpoint(baseUrl: string, adminToken: string): Promise<void> {
  await endpointMutation<void>({ method: "DELETE", body: JSON.stringify({ baseUrl }) }, adminToken);
}

/** 이 대화에서 진행 중인 컨텍스트 압축(새로 열었거나 새로 고친 페이지가 확인한다). */
export function getCompactionStatus(conversationId: string): Promise<CompactionStatusResponse> {
  return request<CompactionStatusResponse>(`/conversations/${encodeURIComponent(conversationId)}/compaction`);
}

/** 내 권한과 개인 키 등록 상태. 키 값 자체는 돌아오지 않는다. */
export function getMyAccess(): Promise<MyAccess> {
  return request<MyAccess>("/me/access");
}

export function setPersonalKey(name: PersonalKeyName, value: string, label?: string): Promise<{ keys: MyAccess["keys"] }> {
  return request(`/me/keys/${name}`, { method: "PUT", body: JSON.stringify({ value, ...(label ? { label } : {}) }) });
}

/** 여러 개 둔 키(GitLab) 중 하나를 지운다. */
export function deletePersonalKeyEntry(name: PersonalKeyName, id: string): Promise<{ keys: MyAccess["keys"] }> {
  return request(`/me/keys/${name}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function deletePersonalKey(name: PersonalKeyName): Promise<{ keys: MyAccess["keys"] }> {
  return request(`/me/keys/${name}`, { method: "DELETE" });
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
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

export function listNotices(): Promise<NoticesResponse> {
  return request<NoticesResponse>("/notices");
}

export function markNoticesSeen(): Promise<{ seenAt: string; unread: number }> {
  return request<{ seenAt: string; unread: number }>("/notices/seen", { method: "POST" });
}

export function createNotice(input: { title: string; body: string }): Promise<{ notice: Notice }> {
  return request<{ notice: Notice }>("/admin/notices", { method: "POST", body: JSON.stringify(input) });
}

export function updateNotice(id: string, input: { title?: string; body?: string }): Promise<{ notice: Notice }> {
  return request<{ notice: Notice }>(`/admin/notices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteNotice(id: string): Promise<void> {
  return request<void>(`/admin/notices/${encodeURIComponent(id)}`, { method: "DELETE" });
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

/** 이 대화에 이미 있는 공유 토큰. 공유한 적이 없으면 null. */
export async function getShareToken(conversationId: string): Promise<string | null> {
  return (await request<{ token: string | null }>(`/conversations/${conversationId}/share`)).token;
}

/** 지금 모습으로 사본을 뜨거나 고친다. 이미 공유한 대화면 서버가 원래 토큰을 돌려준다. */
export async function saveShare(conversationId: string, token: string): Promise<string> {
  return (
    await request<{ token: string }>(`/conversations/${conversationId}/share`, {
      method: "PUT",
      body: JSON.stringify({ token }),
    })
  ).token;
}

export function getSharedConversation(token: string): Promise<SharedConversation> {
  return request<SharedConversation>(`/shared/${encodeURIComponent(token)}`);
}

export function sharedAttachmentUrl(token: string, attachmentId: string): string {
  return apiPath(`/shared/${encodeURIComponent(token)}/attachments/${attachmentId}`);
}

/** 크롬 명령의 결과를 서버의 도구 루프에 돌려준다(server/routes/browser.ts). */
export async function postBrowserActionResult(
  conversationId: string,
  callId: string,
  outcome: { ok: boolean; result?: unknown; error?: string },
): Promise<void> {
  await request<void>(`/conversations/${conversationId}/browser-actions/${callId}`, {
    method: "POST",
    body: JSON.stringify(outcome),
  });
}

export function listSchedules(): Promise<{ now: string; tasks: ScheduledTask[] }> {
  return request(`/schedules`);
}

export function cancelSchedule(id: string): Promise<{ task: ScheduledTask }> {
  return request(`/schedules/${id}/cancel`, { method: "POST" });
}

/** 크롬 예약을 이 탭이 맡는다. 다른 탭이 먼저 맡았으면 409(ApiError). */
export function claimSchedule(id: string): Promise<{ task: ScheduledTask; prompt: string }> {
  return request(`/schedules/${id}/claim`, { method: "POST" });
}

export function finishSchedule(id: string, ok: boolean, note?: string): Promise<{ task: ScheduledTask }> {
  return request(`/schedules/${id}/finish`, { method: "POST", body: JSON.stringify({ ok, ...(note ? { note } : {}) }) });
}

