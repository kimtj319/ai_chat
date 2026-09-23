import { useCallback, useRef, useState } from "react";
import { sendMessage as postMessage, stopGeneration as postStopGeneration, answerNow as postAnswerNow } from "../api/client";
import type { ChatMessage, ToolCall } from "../api/types";
import { createId } from "../state/defaults";
import { useStore } from "../state/StoreContext";
import type { ClientChatMessage, LiveToolResult } from "../state/types";

/**
 * turn_started 가 도착하기 전까지 쓰는 기본값 — 서버 설정(ANSWER_NOW_THRESHOLD_MS)
 * 의 기본값과 같다. turnStartedAt 이 null 인 동안은 shouldShowAnswerNowButton
 * 이 어차피 버튼을 띄우지 않으므로, 이 값이 실제로 쓰이는 창은 아주 짧다.
 */
const DEFAULT_ANSWER_NOW_AFTER_MS = 3 * 60 * 1000;

export function useChatStream() {
  const { appendMessage, patchMessage, replaceMessage, refreshConversations } = useStore();
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

  const sendMessage = useCallback(
    (conversationId: string, text: string, attachmentIds: string[] = []) => {
      const trimmed = text.trim();
      // An attachment with no text is a complete turn, so the guard widens to
      // "nothing at all to send" rather than "no text".
      if ((trimmed.length === 0 && attachmentIds.length === 0) || isStreaming) return;

      const controller = new AbortController();
      abortRef.current = controller;
      streamingIdRef.current = conversationId;
      setIsStreaming(true);
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
      }

      const body = attachmentIds.length > 0 ? { content: trimmed, attachmentIds } : { content: trimmed };
      void postMessage(conversationId, body, controller.signal, {
        onEvent: (event) => {
          switch (event.type) {
            case "user_message":
              appendMessage(conversationId, event.message);
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

            case "reasoning": {
              setAnswerStreaming(false);
              reasoning += event.delta;
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { reasoning });
              break;
            }

            case "content": {
              setAnswerStreaming(true);
              content += event.delta;
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { content });
              break;
            }

            case "tool_call": {
              setAnswerStreaming(false);
              toolCalls = [...toolCalls, { id: event.id, name: event.name, arguments: event.arguments }];
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { toolCalls });
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
              const finalMessage: ClientChatMessage = { ...(event.message as ChatMessage) };
              if (assistantId) {
                replaceMessage(conversationId, assistantId, finalMessage);
              } else {
                appendMessage(conversationId, finalMessage);
              }
              void refreshConversations();
              stopStreamingFlag();
              break;
            }

            case "error": {
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { error: event.message, streaming: false });
              stopStreamingFlag();
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
          if (assistantId) {
            patchMessage(conversationId, assistantId, { streaming: false });
          }
          stopStreamingFlag();
        },
        onError: (message) => {
          const id = ensurePlaceholder();
          patchMessage(conversationId, id, { error: message, streaming: false });
          stopStreamingFlag();
        },
      });
    },
    [isStreaming, appendMessage, patchMessage, replaceMessage, refreshConversations],
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
    sendMessage,
    stopGeneration,
    turnStartedAt,
    answerNowAfterMs,
    answerNowState,
    answerStreaming,
    requestAnswerNow,
  };
}
