import { useCallback, useEffect, useRef, useState } from "react";
import { sendMessage as postMessage, stopGeneration as postStopGeneration, answerNow as postAnswerNow } from "../api/client";
import type { ChatMessage, SendMessageRequest, ToolCall } from "../api/types";
import { browserControlActive } from "../browser/browserControl";
import { showToast } from "../components/Toast";
import { runBrowserAction } from "../browser/runBrowserAction";
import { createId } from "../state/defaults";
import { friendlyError, isUserStop } from "../state/friendlyError";
import { setGeneratingConversations } from "../state/generatingConversations";
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

/** 대화 하나에서 흐르고 있는 턴의 화면 상태. 대화마다 따로 둔다 — 한 대화가 답하는 동안 다른 대화는 그대로 쓸 수 있다. */
export interface TurnState {
  /** 서버가 보낸 이 턴의 시작 시각. "지금 답변하기" 의 기준이다. */
  turnStartedAt: number | null;
  answerNowAfterMs: number;
  /** 이번 턴에서 "지금 답변하기" 를 이미 눌렀는지 — 두 번 누르기를 막고 "정리하는 중…" 을 띄운다. */
  answerNowState: "idle" | "requested";
  /**
   * 모델이 지금 답변 글자(content)를 내보내는 중인가. 추론·도구 이벤트가 오면 다시
   * 거짓이 된다 — 도구 사이에 끼는 짧은 말("찾아보겠습니다") 뒤에 다시 일하러 가면
   * "지금 답변하기" 가 되살아나야 하기 때문이다.
   */
  answerStreaming: boolean;
  /** 컨텍스트를 압축하는 중. 그동안 그 대화의 입력창을 막는다(Composer). */
  compacting: boolean;
}

const NEW_TURN: TurnState = {
  turnStartedAt: null,
  answerNowAfterMs: DEFAULT_ANSWER_NOW_AFTER_MS,
  answerNowState: "idle",
  answerStreaming: false,
  compacting: false,
};

const BUSY_NOTE = "이 대화에서 답변이 진행 중이라 보내지 못했습니다.";
const STOPPED_NOTE = "답변이 끝나기 전에 중지되었습니다.";
/** 다시 생성·편집을 첫 글자 전에 멈췄다. 화면이 갑자기 이전 답으로 돌아가는 까닭을 한 줄로 말한다. */
const KEPT_ON_STOP = "새 답이 나오기 전에 멈춰 이전 답을 그대로 두었습니다.";

export function useChatStream() {
  const { upsertMessage, refreshConversations, rewindToLastUserMessage, activeConversationId } = useStore();
  // 흐르고 있는 턴들, 대화 id 별로. 키가 있으면 그 대화가 답하는 중이다.
  const [turns, setTurns] = useState<Readonly<Record<string, TurnState>>>({});
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // 멈춤이 끊을 fetch. 대화마다 하나 — 한 대화의 멈춤이 다른 대화의 답을 끊지 않는다.
  const controllersRef = useRef(new Map<string, AbortController>());
  // Esc(멈춤 단축키)는 지금 보고 있는 대화의 턴만 멈춘다.
  const activeIdRef = useRef(activeConversationId);
  activeIdRef.current = activeConversationId;

  // 사이드바가 "답변 중" 을 그릴 수 있도록(state/generatingConversations.ts).
  useEffect(() => {
    setGeneratingConversations(Object.keys(turns));
  }, [turns]);
  useEffect(() => () => setGeneratingConversations([]), []);

  /** 그 대화의 턴이 아직 있으면 고친다. 값이 그대로면 다시 그리지 않는다(content 조각마다 불린다). */
  const updateTurn = useCallback((conversationId: string, patch: Partial<TurnState>) => {
    setTurns((prev) => {
      const current = prev[conversationId];
      if (!current) return prev;
      const keys = Object.keys(patch) as Array<keyof TurnState>;
      if (keys.every((key) => Object.is(current[key], patch[key]))) return prev;
      return { ...prev, [conversationId]: { ...current, ...patch } };
    });
  }, []);

  /**
   * 한 턴을 흘려 받는다. 보통 전송과 다시 생성·편집 재전송이 같이 쓴다 — 다른
   * 것은 `rewind` 하나뿐이다: 있으면 서버의 user_message 가 새로 덧붙지 않고 미리
   * 되감아 둔 마지막 사용자 메시지 자리를 대신한다(같은 메시지가 두 번 보이지
   * 않는다). 새 답이 한 글자도 나오기 전에 끝나면(서버가 받아들이기 전의 실패,
   * 멈춤, 실패) 되감기를 되돌린다 — 서버도 같은 경우에 이전 답을 되돌려 둔다
   * (server/routes/conversationTurn.ts restoreRewound).
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
      controllersRef.current.set(conversationId, controller);
      // 새 턴이다 — 이전 턴의 "지금 답변하기" 상태를 물려받지 않는다.
      setTurns((prev) => ({ ...prev, [conversationId]: NEW_TURN }));

      // 흐르는 답의 자리. 이벤트마다 이 사본을 고치고, 화면에는 한 프레임에 한 번만
      // 보낸다(A3-12): 조각마다 그리면 긴 답에서 마크다운 해석이 조각 수만큼 반복됐다.
      // 사본 전체를 보내므로 조각이 빠지는 일이 없고, 끝은 서버의 done 이 대신한다.
      let live: ClientChatMessage | null = null;
      let frame: number | null = null;
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
      // 서버가 이전 답을 되돌려 놓았다(restored). 그 뒤로는 새 답의 자리를 만들지 않는다.
      let restored = false;
      // done·error 로 이미 끝냈다. 스트림의 마지막 onDone 은 할 일이 없다.
      let ended = false;

      /** 생각이 시작됐는데 아직 안 끝났으면 지금 끝낸다. 붙일 patch 를 돌려준다. */
      function endReasoning(): Partial<ClientChatMessage> {
        if (reasoningStartedAt === undefined || reasoningEndedAt !== undefined) return {};
        reasoningEndedAt = Date.now();
        return { reasoningEndedAt };
      }

      function cancelFrame() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      }

      function flush() {
        cancelFrame();
        if (live) upsertMessage(conversationId, [live.id], live);
      }

      function ensurePlaceholder() {
        if (live || restored) return;
        live = { id: createId(), role: "assistant", content: "", streaming: true, createdAt: new Date().toISOString() };
        // 자리는 곧바로 — "답변을 생성하는 중…" 이 한 프레임이라도 늦지 않게.
        flush();
      }

      function patchLive(patch: Partial<ClientChatMessage>) {
        ensurePlaceholder();
        if (!live) return;
        live = { ...live, ...patch };
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            if (live) upsertMessage(conversationId, [live.id], live);
          });
        }
      }

      /**
       * 다시 생성·편집이 새 답을 한 글자도 내지 못했으면 화면을 되감기 전으로 돌린다.
       * 서버가 아직 받아들이지 않았으면(409 등) 서버의 기록도 그대로이고, 받아들인
       * 뒤라면 서버가 같은 규칙으로 이전 답을 되돌려 둔다. 되돌렸으면 true.
       */
      function restoreIfNothingNew(): boolean {
        if (!rewind || restored) return restored;
        if (userConfirmed && content.trim().length > 0) return false;
        cancelFrame();
        live = null;
        restored = true;
        rewind.restore();
        return true;
      }

      function finish() {
        ended = true;
        cancelFrame();
        if (controllersRef.current.get(conversationId) === controller) controllersRef.current.delete(conversationId);
        setTurns((prev) => {
          if (!prev[conversationId]) return prev;
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
      }

      void postMessage(conversationId, body, controller.signal, {
        onEvent: (event) => {
          switch (event.type) {
            case "user_message":
              userConfirmed = true;
              // 다시 생성이면 되감아 둔 자리를 서버의 메시지(id·편집된 내용)로 맞춘다.
              upsertMessage(conversationId, rewind ? [rewind.userMessageId, event.message.id] : [event.message.id], event.message);
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
              updateTurn(conversationId, { turnStartedAt: event.startedAt, answerNowAfterMs: event.answerNowAfterMs });
              break;

            // 모델이 동시 요청 상한에 차 있다. 차례가 오면 첫 생각·글자·도구 호출이 지운다.
            case "queued":
              patchLive({ queuedAhead: event.ahead });
              break;

            case "reasoning":
              updateTurn(conversationId, { answerStreaming: false });
              reasoning += event.delta;
              if (reasoningStartedAt === undefined) {
                reasoningStartedAt = Date.now();
                patchLive({ reasoning, reasoningStartedAt, queuedAhead: undefined });
              } else {
                patchLive({ reasoning });
              }
              break;

            case "content":
              updateTurn(conversationId, { answerStreaming: true });
              content += event.delta;
              patchLive({ content, queuedAhead: undefined, ...endReasoning() });
              break;

            case "tool_call":
              updateTurn(conversationId, { answerStreaming: false });
              toolCalls = [...toolCalls, { id: event.id, name: event.name, arguments: event.arguments }];
              patchLive({ toolCalls, queuedAhead: undefined, ...endReasoning() });
              break;

            case "tool_result":
              updateTurn(conversationId, { answerStreaming: false });
              liveToolResults = [
                ...liveToolResults,
                { id: event.id, name: event.name, ok: event.ok, durationMs: event.durationMs, preview: event.preview },
              ];
              patchLive({ liveToolResults });
              break;

            // 서버가 사용자의 크롬에서 실행할 명령을 보냈다. 확장에 넘기고(필요하면 사용자에게
            // 묻고) 결과를 서버에 돌려준다. 기다리지 않는다 — 스트림은 계속 흘러야 한다.
            case "browser_action":
              void runBrowserAction(conversationId, event, controller.signal);
              break;

            case "compaction":
              if (event.phase === "end") {
                updateTurn(conversationId, { compacting: false });
                patchLive({ compaction: undefined });
              } else {
                updateTurn(conversationId, { compacting: true });
                patchLive({ compaction: { kind: event.kind, progress: event.progress } });
              }
              break;

            case "usage":
              patchLive({
                usage: {
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  totalTokens: event.totalTokens,
                },
              });
              break;

            case "notice":
              // A turn can emit more than one note; keep the earlier ones so
              // the reason the run changed course is not overwritten.
              notice = notice.length > 0 ? `${notice}\n${event.message}` : event.message;
              patchLive({ notice });
              break;

            // 다시 생성이 아무것도 못 만들고 끝나 서버가 이전 답을 되돌려 놓았다.
            case "restored":
              if (rewind && !restored) {
                cancelFrame();
                live = null;
                restored = true;
                rewind.restore();
              }
              break;

            case "done": {
              endReasoning();
              // 서버의 메시지가 자리를 대신해도 생각 시각은 남긴다(서버는 이 둘을 모른다).
              const message = event.message as ChatMessage;
              const finalMessage: ClientChatMessage = {
                ...message,
                ...(reasoningStartedAt !== undefined ? { reasoningStartedAt, reasoningEndedAt } : {}),
              };
              cancelFrame();
              upsertMessage(conversationId, live ? [live.id, finalMessage.id] : [finalMessage.id], finalMessage);
              void refreshConversations();
              finish();
              settle(!message.error && !message.stopped, message.error ?? (message.stopped ? STOPPED_NOTE : undefined));
              break;
            }

            case "error": {
              // 멈춤(다른 탭의 멈춤 단추 등)은 오류가 아니다. 서버가 뒤이어 멈춘 답(done)이나
              // 되돌린 이전 답(restored)을 보낸다 — 그때까지 기다린다.
              if (isUserStop(event.message)) {
                patchLive({ stopped: true });
                break;
              }
              // 다시 생성이 실패했지만 서버가 이전 답을 되돌려 놓았다. 화면도 그 답으로
              // 돌아갔으니 실패는 한 줄로 알린다.
              if (restored) {
                showToast(`다시 생성하지 못해 이전 답을 그대로 두었습니다. ${friendlyError(event.message) ?? ""}`.trim(), "error");
                finish();
                settle(false, event.message);
                break;
              }
              patchLive({ error: event.message, streaming: false, ...endReasoning() });
              flush();
              finish();
              settle(false, event.message);
              break;
            }

            default:
              break;
          }
        },
        onDone: () => {
          if (ended) return;
          // Covers the normal end-of-stream sentinel as well as an aborted
          // (Stop button) stream that never got a "done"/"error" event —
          // either way the UI must stop showing this message as streaming.
          const wasRestored = restored;
          if (restoreIfNothingNew()) {
            if (userConfirmed || wasRestored) showToast(KEPT_ON_STOP);
          } else if (live) {
            // 멈춘 답은 받은 데까지 그대로 두고 "중지됨" 으로 보인다 — 서버도 같은
            // 글을 stopped 로 저장한다(server/chat/turnMessage.ts).
            patchLive({ streaming: false, ...(controller.signal.aborted ? { stopped: true } : {}), ...endReasoning() });
            flush();
          }
          finish();
          settle(false, STOPPED_NOTE);
        },
        onError: (message) => {
          if (ended) return;
          // 409(다른 턴이 진행 중)·400 처럼 서버가 아무것도 바꾸지 않은 실패이거나, 흐르던
          // 중에 연결이 끊겼다. 다시 생성이면 이전 답으로 돌아가고 실패만 알린다.
          if (restoreIfNothingNew()) {
            showToast(`다시 생성하지 못해 이전 답을 그대로 두었습니다. ${friendlyError(message) ?? ""}`.trim(), "error");
          } else {
            patchLive({ error: message, streaming: false, ...endReasoning() });
            flush();
          }
          finish();
          settle(false, message);
        },
      });
    },
    [upsertMessage, refreshConversations, updateTurn],
  );

  const sendMessage = useCallback(
    (conversationId: string, text: string, attachmentIds: string[] = [], options: SendOptions = {}) => {
      const trimmed = text.trim();
      // An attachment with no text is a complete turn, so the guard widens to
      // "nothing at all to send" rather than "no text".
      if ((trimmed.length === 0 && attachmentIds.length === 0) || controllersRef.current.has(conversationId)) {
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
    [runTurn],
  );

  /**
   * 마지막 답을 다시 생성한다. 화면에서 마지막 사용자 메시지 뒤를 먼저 지우고,
   * 서버가 같은 자리를 잘라 같은 질문(첨부 포함)으로 다시 돌린다.
   */
  const regenerateLast = useCallback(
    (conversationId: string, options: SendOptions = {}) => {
      if (controllersRef.current.has(conversationId)) {
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
    [rewindToLastUserMessage, runTurn],
  );

  /** 마지막 사용자 메시지의 내용을 바꿔 다시 보낸다(첨부는 그대로). 빈 내용은 보내지 않는다. */
  const editLastAndResend = useCallback(
    (conversationId: string, content: string, options: SendOptions = {}) => {
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        options.onSettled?.(false, "내용을 입력해 주세요.");
        return;
      }
      if (controllersRef.current.has(conversationId)) {
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
    [rewindToLastUserMessage, runTurn],
  );

  /** 그 대화의 턴을 멈춘다. 대화를 주지 않으면(Esc) 지금 보고 있는 대화의 턴만 멈춘다. */
  const stopGeneration = useCallback((conversationId?: string) => {
    const id = conversationId ?? activeIdRef.current;
    const controller = id ? controllersRef.current.get(id) : undefined;
    if (!id || !controller) return;
    // Tell the server first — it is what actually cancels the vLLM call and
    // the tool loop. Aborting our own fetch only closes the browser's end.
    void postStopGeneration(id).catch(() => {});
    controller.abort();
  }, []);

  /**
   * "지금 답변하기". Stop 과 달리 우리 쪽 fetch 는 건드리지 않는다 — 스트림은
   * 그대로 흐르고, 서버가 마무리 답변으로 넘어가면서 같은 스트림에 이어
   * 보낸다. 두 번 누르는 것은 answerNowState 로 막는다: 서버 쪽 신호는
   * idempotent 하지만(끝난 턴에 다시 보내도 무해하다), 버튼은 한 번만 눌리는
   * 것처럼 보여야 한다.
   */
  const requestAnswerNow = useCallback(
    (conversationId: string) => {
      const turn = turnsRef.current[conversationId];
      if (!turn || turn.answerNowState === "requested") return;
      updateTurn(conversationId, { answerNowState: "requested" });
      void postAnswerNow(conversationId).catch(() => {});
    },
    [updateTurn],
  );

  return {
    /** 어느 대화에서든 답이 흐르는 중인가(예약 작업은 모든 턴이 끝나길 기다린다). */
    isStreaming: Object.keys(turns).length > 0,
    /** 흐르고 있는 턴들, 대화 id 별로. 화면은 열린 대화의 것만 본다. */
    turns,
    sendMessage,
    regenerateLast,
    editLastAndResend,
    stopGeneration,
    requestAnswerNow,
  };
}
