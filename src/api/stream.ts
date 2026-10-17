import { errorMessage } from "../state/friendlyError";
import { apiPath } from "./base";
import { extractErrorMessage, notifyUnauthorized } from "./http";
import { flushSseBuffer, parseSseChunk } from "./sseParser";
import type { SendMessageRequest, ServerEvent } from "./types";

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
    response = await fetch(apiPath(`/conversations/${conversationId}/messages`), {
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
    callbacks.onError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`);
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
    callbacks.onError(`스트림을 읽는 중 오류가 발생했습니다: ${errorMessage(error)}`);
  }
}
