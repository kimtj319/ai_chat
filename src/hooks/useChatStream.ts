import { useCallback, useRef, useState } from "react";
import { sendMessage as postMessage, stopGeneration as postStopGeneration } from "../api/client";
import type { ChatMessage, ToolCall } from "../api/types";
import { createId } from "../state/defaults";
import { useStore } from "../state/StoreContext";
import type { ClientChatMessage, LiveToolResult } from "../state/types";

export function useChatStream() {
  const { appendMessage, patchMessage, replaceMessage, refreshConversations } = useStore();
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Which conversation the in-flight turn belongs to, so Stop can name it to
  // the server. Cleared alongside abortRef when the stream ends.
  const streamingIdRef = useRef<string | null>(null);

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
              break;

            // The summarised name landed; pick it up without waiting for the
            // answer to finish.
            case "title":
              void refreshConversations();
              break;

            case "reasoning": {
              reasoning += event.delta;
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { reasoning });
              break;
            }

            case "content": {
              content += event.delta;
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { content });
              break;
            }

            case "tool_call": {
              toolCalls = [...toolCalls, { id: event.id, name: event.name, arguments: event.arguments }];
              const id = ensurePlaceholder();
              patchMessage(conversationId, id, { toolCalls });
              break;
            }

            case "tool_result": {
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

  return { isStreaming, sendMessage, stopGeneration };
}
