import { useCallback, useRef, useState } from "react";
import { sendMessage as postMessage, stopGeneration as postStopGeneration, answerNow as postAnswerNow } from "../api/client";
import type { ChatMessage, SendMessageRequest, ToolCall } from "../api/types";
import { browserControlActive } from "../browser/browserControl";
import { runBrowserAction } from "../browser/runBrowserAction";
import { createId } from "../state/defaults";
import { useStore } from "../state/StoreContext";
import type { ClientChatMessage, LiveToolResult } from "../state/types";

/**
 * turn_started 가 도착하기 전까지 쓰는 기본값 — 서버 설정(ANSWER_NOW_THRESHOLD_MS)
 * 의 기본값과 같다. turnStartedAt 이 null 인 동안은 shouldShowAnswerNowButton
 * 이 어차피 버튼을 띄우지 않으므로, 이 값이 실제로 쓰이는 창은 아주 짧다.
 */
const DEFAULT_ANSWER_NOW_AFTER_MS = 3 * 60 * 1000;

export interface SendOptions {
  /** 입력창 스위치와 상관없이 이 턴의 크롬 제어를 켠다/끈다(예약 작업이 쓴다). */
  browserControl?: boolean;
  /** 턴이 끝나면(답·오류·중지) 한 번 불린다. */
  onSettled?: (ok: boolean, note?: string) => void;
}

/** 다시 생성·편집 재전송에서 화면을 미리 되감아 둔 것(StoreContext.rewindToLastUserMessage). */
interface Rewind {
  userMessageId: string;
  restore: () => void;
}

const BUSY_NOTE = "다른 답변이 진행 중이라 보내지 못했습니다.";

export function useChatStream() {
  const { appendMessage, patchMessage, replaceMessage, refreshConversations, rewindToLastUserMessage } = useStore();
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Which conversation the in-flight turn belongs to, so Stop and answerNow
  // can name it to the server. Cleared alongside abortRef when the stream ends.
  const streamingIdRef = useRef<string | null>(null);
  // "지금 답변하기" 의 기준: 서버가 보낸 이 턴의 시작 시각과, 버튼이 뜨는
  // 임계값. 새 턴을 보낼 때마다, 그리고 스트림이 끝날 때마다 지운다 — 다음
  // 턴이 이전 턴의 시각을 물려받아 버튼이 즉시 뜨는 일이 없도록.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [answerNowAfterMs, setAnswerNowAfterMs] = useState(DEFAULT_ANSWER_NOW_AFTER_MS);
  // 이번 턴에서 이미 눌렀는지 — 두 번 누르는 것을 막고, 버튼을 "정리하는
  // 중…" 상태로 바꾸는 데 쓴다.
  const [answerNowState, setAnswerNowState] = useState<"idle" | "requested">("idle");
  // 모델이 지금 답변 글자(content)를 내보내는 중인가. 추론·도구 이벤트가 오면
  // 다시 거짓이 된다 — 도구 사이에 끼는 짧은 말("찾아보겠습니다") 뒤에 다시
  // 일하러 가면 "지금 답변하기" 가 되살아나야 하기 때문이다.
  const [answerStreaming, setAnswerStreaming] = useState(false);
  // 컨텍스트를 압축하는 중인 대화. 그동안 입력창을 막는다(Composer).
  const [compactingId, setCompactingId] = useState<string | null>(null);
  // 지금 흘려 받는 대화 — 그 대화의 압축은 스트림이 알려 주므로 서버에 따로 묻지 않는다.
  const [streamingId, setStreamingId] = useState<string | null>(null);

  /**
   * 한 턴을 흘려 받는다. 보통 전송과 다시 생성·편집 재전송이 같이 쓴다 — 다른
   * 것은 `rewind` 하나뿐이다: 있으면 서버의 user_message 가 새로 덧붙지 않고 미리
   * 되감아 둔 마지막 사용자 메시지 자리를 대신한다(같은 메시지가 두 번 보이지
   * 않는다). 서버가 그 메시지를 받아들이기 전에 실패하면 되감기를 되돌린다 —
   * 서버의 기록은 그대로이므로 화면도 그대로여야 한다.
   */
  const runTurn = useCallback(
    (conversationId: string, body: SendMessageRequest, options: SendOptions, rewind: Rewind | null) => {
      let settled = false;
      const settle = (ok: boolean, note?: string) => {
        if (settled) return;
        settled = true;
        options.onSettled?.(ok, note);
      };

      const controller = new AbortController();
      abortRef.current = controller;
      streamingIdRef.current = conversationId;
      setIsStreaming(true);
      setStreamingId(conversationId);
      // 새 턴이다 — 이전 턴의 "지금 답변하기" 상태를 물려받지 않는다.
      setTurnStartedAt(null);
      setAnswerNowState("idle");
      setAnswerStreaming(false);

      let assistantId: string | null = null;
      let content = "";
      let reasoning = "";
      let notice = "";
      let toolCalls: ToolCall[] = [];
      let liveToolResults: LiveToolResult[] = [];
      // 생각 시간(ThinkingPanel): 첫 reasoning delta 와, 그 뒤 첫 content·도구 호출 시각.
      let reasoningStartedAt: number | undefined;
      let reasoningEndedAt: number | undefined;
      // 서버가 이 턴의 사용자 메시지를 받아들였는가(user_message 도착).
      let userConfirmed = false;

      /** 생각이 시작됐는데 아직 안 끝났으면 지금 끝낸다. 붙일 patch 를 돌려준다. */
      function endReasoning(): Partial<ClientChatMessage> {
        if (reasoningStartedAt === undefined || reasoningEndedAt !== undefined) return {};
        reasoningEndedAt = Date.now();
        return { reasoningEndedAt };
      }

      function undoRewindIfUnconfirmed() {
        if (rewind && !userConfirmed) rewind.restore();
      }

      function ensurePlaceholder(): string {
        if (assistantId) return assistantId;
        assistantId = createId();
        const placeholder: ClientChatMessage = {
          id: assistantId,
          role: "assistant",
          content: "",
          streaming: true,
          createdAt: new Date().toISOString(),
        };
        appendMessage(conversationId, placeholder);
        return assistantId;
      }

      function stopStreamingFlag() {
        setIsStreaming(false);
        abortRef.current = null;
        streamingIdRef.current = null;
        // 버튼은 isStreaming 만으로도 가려지지만, 다음 턴이 시작되기 전까지
        // 화면에 남는 상태가 없도록 여기서도 지운다.
        setTurnStartedAt(null);
        setAnswerNowState("idle");
      setAnswerStreaming(false);
        setCompactingId(null);
        setStreamingId(null);
      }

      void postMessage(conversationId, body, controller.signal, {
        onEvent: (event) => {
          switch (event.type) {
            case "user_message":
              userConfirmed = true;
              // 다시 생성이면 되감아 둔 자리를 서버의 메시지(id·편집된 내용)로 맞춘다.
              if (rewind) replaceMessage(conversationId, rewind.userMessageId, event.message);
              else appendMessage(conversationId, event.message);
              // The sidebar row belongs to the request, not to the answer: the
              // server has already stored the conversation under its title by
              // the time this event is sent, so listing it here is what makes
              // the row appear when the user asks rather than a minute later
              // when the model finishes.
              void refreshConversations();
              // Also open the assistant placeholder here rather than waiting
              // for the first reasoning/content/tool event. This is the
              // server's very first reply (sent before history is assembled,
              // attachments are read, or the context budget is measured), so
              // on a long conversation it can arrive many seconds before a
              // single token of the actual answer does. Without this, the
              // "answer is being generated" indicator stayed dark for that
              // whole stretch — placeholder empty, nothing streaming yet — and
              // got slower the longer the conversation ran, even though
              // nothing about the REQUEST was slow.
              ensurePlaceholder();
              break;

            // The summarised name landed; pick it up without waiting for the
            // answer to finish.
            case "title":
              void refreshConversations();
              break;

            // 이 턴의 기준 시각 — "지금 답변하기" 버튼이 언제 뜨는지는 이것과
            // shouldShowAnswerNowButton (state/answerNow.ts) 이 정한다.
            case "turn_started":
              setTurnStartedAt(event.startedAt);
              setAnswerNowAfterMs(event.answerNowAfterMs);
              break;

            // 모델이 동시 요청 상한에 차 있다. 차례가 오면 첫 생각·글자·도구 호출이 지운다.
            case "queued": {
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { queuedAhead: event.ahead });
              break;
            }

            case "reasoning": {
              setAnswerStreaming(false);
              reasoning += event.delta;
              const id = ensurePlaceholder();
              if (reasoningStartedAt === undefined) {
                reasoningStartedAt = Date.now();
                patchMessage(conversationId, id, { reasoning, reasoningStartedAt, queuedAhead: undefined });
              } else {
                patchMessage(conversationId, id, { reasoning });
              }
              break;
            }

            case "content": {
              setAnswerStreaming(true);
              content += event.delta;
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { content, queuedAhead: undefined, ...endReasoning() });
              break;
            }

            case "tool_call": {
              setAnswerStreaming(false);
              toolCalls = [...toolCalls, { id: event.id, name: event.name, arguments: event.arguments }];
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { toolCalls, queuedAhead: undefined, ...endReasoning() });
              break;
            }

            case "tool_result": {
              setAnswerStreaming(false);
              liveToolResults = [
                ...liveToolResults,
                { id: event.id, name: event.name, ok: event.ok, durationMs: event.durationMs, preview: event.preview },
              ];
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { liveToolResults });
              break;
            }

            // 서버가 사용자의 크롬에서 실행할 명령을 보냈다. 확장에 넘기고(필요하면 사용자에게
            // 묻고) 결과를 서버에 돌려준다. 기다리지 않는다 — 스트림은 계속 흘러야 한다.
            case "browser_action":
              void runBrowserAction(conversationId, event, controller.signal);
              break;

            case "compaction": {
              const id = ensurePlaceholder();
              if (event.phase === "end") {
                setCompactingId(null);
                patchMessage(conversationId, id, { compaction: undefined });
              } else {
                setCompactingId(conversationId);
                patchMessage(conversationId, id, { compaction: { kind: event.kind, progress: event.progress } });
              }
              break;
            }

            case "usage": {
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, {
                usage: {
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  totalTokens: event.totalTokens,
                },
              });
              break;
            }

            case "notice": {
              // A turn can emit more than one note; keep the earlier ones so
              // the reason the run changed course is not overwritten.
              notice = notice.length > 0 ? `${notice}\n${event.message}` : event.message;
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { notice });
              break;
            }

            case "done": {
              endReasoning();
              // 서버의 메시지가 자리를 대신해도 생각 시각은 남긴다(서버는 이 둘을 모른다).
              const finalMessage: ClientChatMessage = {
                ...(event.message as ChatMessage),
                ...(reasoningStartedAt !== undefined ? { reasoningStartedAt, reasoningEndedAt } : {}),
              };
              if (assistantId) {
                replaceMessage(conversationId, assistantId, finalMessage);
              } else {
                appendMessage(conversationId, finalMessage);
              }
              void refreshConversations();
              stopStreamingFlag();
              settle(!(event.message as ChatMessage).error, (event.message as ChatMessage).error);
              break;
            }

            case "error": {
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { error: event.message, streaming: false, ...endReasoning() });
              stopStreamingFlag();
              settle(false, event.message);
              break;
            }

            default:
              break;
          }
        },
        onDone: () => {
          // Covers the normal end-of-stream sentinel as well as an aborted
          // (Stop button) stream that never got a "done"/"error" event —
          // either way the UI must stop showing this message as streaming.
          undoRewindIfUnconfirmed();
          if (assistantId) {
            patchMessage(conversationId, assistantId, { streaming: false, ...endReasoning() });
          }
          stopStreamingFlag();
          settle(false, "답변이 끝나기 전에 중지되었습니다.");
        },
        onError: (message) => {
          // 409(다른 턴이 진행 중)·400 처럼 서버가 아무것도 바꾸지 않은 실패다.
          undoRewindIfUnconfirmed();
          const id = ensurePlaceholder();
          patchMessage(conversationId, id, { error: message, streaming: false, ...endReasoning() });
          stopStreamingFlag();
          settle(false, message);
        },
      });
    },
    [appendMessage, patchMessage, replaceMessage, refreshConversations],
  );

  const sendMessage = useCallback(
    (conversationId: string, text: string, attachmentIds: string[] = [], options: SendOptions = {}) => {
      const trimmed = text.trim();
      // An attachment with no text is a complete turn, so the guard widens to
      // "nothing at all to send" rather than "no text".
      if ((trimmed.length === 0 && attachmentIds.length === 0) || isStreaming) {
        options.onSettled?.(false, BUSY_NOTE);
        return;
      }
      runTurn(
        conversationId,
        {
          content: trimmed,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          // 보내는 순간의 상태로 정한다 — 턴 중간에 스위치를 바꿔도 이번 턴의 도구는 그대로다.
          ...((options.browserControl ?? browserControlActive()) ? { browserControl: true } : {}),
        },
        options,
        null,
      );
    },
    [isStreaming, runTurn],
  );

  /**
   * 마지막 답을 다시 생성한다. 화면에서 마지막 사용자 메시지 뒤를 먼저 지우고,
   * 서버가 같은 자리를 잘라 같은 질문(첨부 포함)으로 다시 돌린다.
   */
  const regenerateLast = useCallback(
    (conversationId: string, options: SendOptions = {}) => {
      if (isStreaming) {
        options.onSettled?.(false, BUSY_NOTE);
        return;
      }
      const rewind = rewindToLastUserMessage(conversationId);
      if (!rewind) {
        options.onSettled?.(false, "다시 생성할 메시지가 없습니다.");
        return;
      }
      runTurn(
        conversationId,
        {
          content: "",
          regenerate: true,
          ...((options.browserControl ?? browserControlActive()) ? { browserControl: true } : {}),
        },
        options,
        rewind,
      );
    },
    [isStreaming, rewindToLastUserMessage, runTurn],
  );

  /** 마지막 사용자 메시지의 내용을 바꿔 다시 보낸다(첨부는 그대로). 빈 내용은 보내지 않는다. */
  const editLastAndResend = useCallback(
    (conversationId: string, content: string, options: SendOptions = {}) => {
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        options.onSettled?.(false, "내용을 입력해 주세요.");
        return;
      }
      if (isStreaming) {
        options.onSettled?.(false, BUSY_NOTE);
        return;
      }
      const rewind = rewindToLastUserMessage(conversationId, trimmed);
      if (!rewind) {
        options.onSettled?.(false, "고칠 메시지가 없습니다.");
        return;
      }
      runTurn(
        conversationId,
        {
          content: trimmed,
          regenerate: true,
          ...((options.browserControl ?? browserControlActive()) ? { browserControl: true } : {}),
        },
        options,
        rewind,
      );
    },
    [isStreaming, rewindToLastUserMessage, runTurn],
  );

  const stopGeneration = useCallback(() => {
    // Tell the server first — it is what actually cancels the vLLM call and
    // the tool loop. Aborting our own fetch only closes the browser's end.
    const id = streamingIdRef.current;
    if (id) void postStopGeneration(id).catch(() => {});
    abortRef.current?.abort();
  }, []);

  /**
   * "지금 답변하기". Stop 과 달리 우리 쪽 fetch 는 건드리지 않는다 — 스트림은
   * 그대로 흐르고, 서버가 마무리 답변으로 넘어가면서 같은 스트림에 이어
   * 보낸다. 두 번 누르는 것은 answerNowState 로 막는다: 서버 쪽 신호는
   * idempotent 하지만(끝난 턴에 다시 보내도 무해하다), 버튼은 한 번만 눌리는
   * 것처럼 보여야 한다.
   */
  const requestAnswerNow = useCallback(() => {
    const id = streamingIdRef.current;
    if (!id || answerNowState === "requested") return;
    setAnswerNowState("requested");
    void postAnswerNow(id).catch(() => {});
  }, [answerNowState]);

  return {
    isStreaming,
    streamingId,
    compactingId,
    sendMessage,
    regenerateLast,
    editLastAndResend,
    stopGeneration,
    turnStartedAt,
    answerNowAfterMs,
    answerNowState,
    answerStreaming,
    requestAnswerNow,
  };
}
