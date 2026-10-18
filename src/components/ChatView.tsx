import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentLimitsFor } from "../attachments/limits";
import { DROP_SUBTITLE, DROP_TITLE } from "../attachments/messages";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import type { useChatStream } from "../hooks/useChatStream";
import { useFileDrop } from "../hooks/useFileDrop";
import { useFollowBottom } from "../hooks/useFollowBottom";
import { useHealthCheck } from "../hooks/useHealthCheck";
import { shouldShowAnswerNowButton } from "../state/answerNow";
import { capabilityOf, kindOf } from "../state/modelCapability";
import { useStore, useActiveConversation } from "../state/StoreContext";
import type { ClientChatMessage } from "../state/types";
import { AnswerNowButton } from "./AnswerNowButton";
import { Composer } from "./Composer";
import { ConversationExportActions } from "./ConversationExportActions";
import { MessageItem } from "./MessageItem";
import { shortModelName } from "../state/modelCatalog";
import { useModels } from "../hooks/useModels";
import { useMcpLibrary } from "../hooks/useMcpLibrary";
import { useRemoteCompaction } from "../hooks/useRemoteCompaction";
import { StatusBanner } from "./StatusBanner";
import { ScheduleBanner } from "./ScheduleBanner";
import { CompactionProgress } from "./CompactionProgress";
import { ChevronDownIcon, PaperclipIcon } from "./icons";
import "./ChatView.css";
import { prefetchBoardList } from "../state/boardCache";
import { NoticeButton } from "./NoticeButton";
import { SourcePicker } from "./SourcePicker";
import { useScrollKeys } from "../hooks/useScrollKeys";

interface ChatViewProps {
  chatStream: ReturnType<typeof useChatStream>;
  /** Opens the 라이브러리 page, from the composer's MCP picker. */
  onOpenLibrary: () => void;
  onOpenTools: () => void;
  /** Opens the 문의 게시판 page, from the header. */
  onOpenBoard: () => void;
}

/* 말풍선 안에 줄 두 개 — 게시판은 결국 오가는 말이다. 연필(새 대화)과 실루엣이
   겹치지 않아 나란히 놓여도 구분된다. */
function BoardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
      <path d="M8.5 10h7" />
      <path d="M8.5 13.5h4.5" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

export function ChatView({
  chatStream,
  onOpenLibrary,
  onOpenTools,
  onOpenBoard,
}: ChatViewProps) {
  const { createConversation, selectConversation, ui, setSidebarCollapsed } = useStore();
  // 메시지를 그리는 쪽이라 흐르는 값을 직접 읽는다 — 토큰마다 다시 그려지는 것이 여기서는 제 일이다.
  const { activeConversation, activeConversationLoading, activeConversationError } = useActiveConversation();
  // A conversation with an empty `model` uses whatever the server defaults to,
  // which is the first entry of the catalog — show that name rather than blank.
  const { models, catalog, current } = useModels();
  const {
    isStreaming,
    sendMessage,
    stopGeneration,
    turnStartedAt,
    answerNowAfterMs,
    answerNowState,
    answerStreaming,
    requestAnswerNow,
    regenerateLast,
    editLastAndResend,
  } = chatStream;
  // 도구 줄이 MCP 도구를 "<서버 이름> 사용" 으로 쓰도록 slug → 이름.
  const { servers: mcpServers } = useMcpLibrary();
  const mcpServerNames = useMemo(() => Object.fromEntries(mcpServers.map((server) => [server.slug, server.name])), [mcpServers]);
  const activeId = activeConversation?.id ?? null;
  // 이 페이지가 흘려 받지 않는 압축(새로 고침·다시 열기)은 서버에 묻는다. 끝나면 요약된 대화를 다시 불러온다.
  const remoteCompaction = useRemoteCompaction(activeId, chatStream.streamingId !== activeId, () => {
    if (activeId) void selectConversation(activeId);
  });
  const compacting = (activeId !== null && chatStream.compactingId === activeId) || remoteCompaction !== null;
  const { status, retrying, retry } = useHealthCheck();
  const listRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const hasConversation = activeConversation !== null;
  // 입력창 묶음(dock)의 키를 --dock-h 로 알린다. 본문은 그만큼 dock 밑으로 들어가
  // 흐르고, 목록 끝에 같은 만큼 여백을 두어 마지막 줄이 입력창에 가리지 않는다.
  // 입력창은 글을 쓰면 늘어나므로 한 번 재지 않고 계속 본다.
  useEffect(() => {
    const view = viewRef.current;
    const dock = dockRef.current;
    if (!view || !dock) return;
    const update = () => view.style.setProperty("--dock-h", `${dock.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    return () => observer.disconnect();
    // The dock mounts and unmounts with the conversation view; while it stays,
    // the observer sees every change in its height. Re-running on every render
    // (every streamed token) only re-created the observer and forced a layout.
  }, [hasConversation]);
  const listInnerRef = useRef<HTMLDivElement>(null);

  // The attachment draft belongs to the open conversation, so it is owned
  // here rather than in Composer — neither component remounts on a
  // conversation switch, and a draft held in Composer would follow the user
  // into the next conversation.
  const conversationId = activeConversation?.id ?? "";
  const limits = attachmentLimitsFor(
    catalog.find((entry) => entry.id === (activeConversation?.model || current)),
    catalog[0]?.maxModelLen,
  );
  const attachments = useAttachmentDraft(conversationId, limits);
  const { addFiles } = attachments;
  const handleDroppedFiles = useCallback((files: File[]) => addFiles(files, "drop"), [addFiles]);
  const { isDragging, dropHandlers } = useFileDrop(handleDroppedFiles);

  const { showJumpToBottom, scrollToBottom } = useFollowBottom(listRef, conversationId, activeConversation?.messages);
  // PageUp·PageDown·Home·End — 본문과 출처 창(PDF 포함)을 넘긴다.
  useScrollKeys();

  // 화면 읽기 프로그램용. 흐르는 동안 목록은 aria-busy 라 조각마다 읽지 않고, 끝나면
  // 아래 status 가 한 번만 말한다. 멈추기는 여기서 누른 것만 안다(단축키로 멈추면 "완료").
  const streamingHere = isStreaming && chatStream.streamingId === activeId;
  const stopRequestedRef = useRef(false);
  const wasStreamingRef = useRef(false);
  const lastMessageRef = useRef<ClientChatMessage | undefined>(undefined);
  lastMessageRef.current = activeConversation?.messages[activeConversation.messages.length - 1];
  const [turnAnnouncement, setTurnAnnouncement] = useState("");
  useEffect(() => {
    if (streamingHere) {
      wasStreamingRef.current = true;
      setTurnAnnouncement("");
      return;
    }
    if (!wasStreamingRef.current) return;
    wasStreamingRef.current = false;
    const stopped = stopRequestedRef.current;
    stopRequestedRef.current = false;
    setTurnAnnouncement(
      stopped
        ? "응답을 중지했습니다"
        : lastMessageRef.current?.error
          ? "응답하지 못했습니다. 오류 안내를 확인해 주세요."
          : "응답 완료",
    );
  }, [streamingHere]);

  const handleStop = useCallback(() => {
    stopRequestedRef.current = true;
    stopGeneration();
  }, [stopGeneration]);

  // "지금 답변하기" 가 뜰 시각을 알기 위한 재렌더 심장박동. 이미 눌렀으면
  // (answerNowState === "requested") 더 잴 것이 없으니 멈춘다 — 그 뒤로는
  // isStreaming 하나로 배너의 "정리하는 중" 상태가 결정된다.
  const [answerNowNow, setAnswerNowNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming || turnStartedAt === null || answerNowState === "requested") return;
    const id = window.setInterval(() => setAnswerNowNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isStreaming, turnStartedAt, answerNowState]);

  const showAnswerNowIdle = shouldShowAnswerNowButton({
    isStreaming,
    turnStartedAt,
    answerNowAfterMs,
    clicked: answerNowState === "requested",
    answerStreaming,
    now: answerNowNow,
  });
  // 누른 뒤에는(pending) "정리하는 중…" 으로 바뀌어 떠 있다가, 마무리 답변이
  // 흘러나오기 시작하면 사라진다 — 답이 보이는데 "정리하는 중" 을 계속 띄울
  // 이유가 없다.
  const answerNowPending = isStreaming && answerNowState === "requested" && !answerStreaming;

  if (!activeConversation) {
    return (
      <div className="chat-view chat-view-empty">
        <StatusBanner status={status} retrying={retrying} onRetry={retry} />
        <div className="chat-empty-state">
          {activeConversationLoading ? (
            <p>대화를 불러오는 중…</p>
          ) : activeConversationError ? (
            <p className="message-error">{activeConversationError}</p>
          ) : (
            <p>선택된 대화가 없습니다.</p>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void createConversation()}>
            새 대화 시작
          </button>
        </div>
      </div>
    );
  }

  const hasMessages = activeConversation.messages.length > 0;

  // Until the first message lands nothing is locked, so the composer follows
  // the model that is selected right now; after that it follows the
  // conversation's own recorded kind.
  const selectedEntry = catalog.find((entry) => entry.id === (activeConversation.model || current));
  const kind = hasMessages
    ? kindOf(activeConversation.kind)
    : capabilityOf(selectedEntry) === "embedding"
      ? "embedding"
      : "chat";
  // "Qwen3.8-27B (abliterated)" → "Qwen3.8-27B": 괄호 꼬리표는 고르는 목록에서 보면 된다.
  const modelLabel = shortModelName(activeConversation.model || current || models[0] || "").replace(/\s*\([^)]*\)$/, "");

  // 모델은 사이드바 바닥의 선택기에서 고른다. 거기를 열어 준다 — 폰이면 서랍을, 접혀
  // 있으면 사이드바를 먼저 펼치고, 그려진 다음 프레임에 선택기를 연다.
  function openModelSelector() {
    const drawerToggle = document.querySelector<HTMLButtonElement>(".app-drawer-toggle");
    if (drawerToggle) drawerToggle.click();
    else if (ui.sidebarCollapsed) setSidebarCollapsed(false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const trigger = document.querySelector<HTMLButtonElement>(".sidebar .model-switcher-trigger");
        if (!trigger) return;
        trigger.focus();
        if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
      }),
    );
  }

  return (
    <div ref={viewRef} className={`chat-view${hasMessages ? " has-messages" : ""}`} {...dropHandlers}>

      {/* pointer-events: none, so crossing it cannot fire another
          dragenter/dragleave pair and strobe the overlay it belongs to. */}
      {isDragging && (
        <div className="chat-drop-overlay" role="status">
          <div className="chat-drop-card">
            <PaperclipIcon />
            <p className="chat-drop-title">{DROP_TITLE}</p>
            <p className="chat-drop-subtitle">{DROP_SUBTITLE}</p>
          </div>
        </div>
      )}

      <header className="chat-header">
        <div className="chat-header-inner">
          {/* 대화 합계 토큰은 머리에 늘 띄우지 않는다 — 답변마다 아래에 같은 숫자가 있어
              화면 위쪽에 떠 있는 알약 하나가 둘째 사본이었다. 합계는 저장 메뉴 아래에 둔다. */}
          <div className="chat-header-left" />
          {/* 답변이 문서를 인용했을 때만 나타난다. 아이콘 묶음 바로 왼쪽. */}
          <SourcePicker messages={activeConversation.messages} />
          <div className="chat-header-right">
            {/* 빈 대화에는 저장·공유할 것이 없다. 꺼 둔 단추를 두면 머리가 왜 안 눌리는지
                모를 아이콘으로 붐빈다(폰에서는 서랍 토글 옆까지 밀려왔다) — 아예 그리지 않는다. */}
            {hasMessages && (
              <ConversationExportActions
                conversation={activeConversation}
                transcriptRef={listInnerRef}
                fallbackModel={current || models[0] || ""}
              />
            )}
            <NoticeButton />
            <button
              type="button"
              className="btn-icon"
              data-tooltip="문의 게시판"
              aria-label="문의 게시판"
              onPointerEnter={prefetchBoardList}
              onFocus={prefetchBoardList}
              onClick={onOpenBoard}
            >
              <BoardIcon />
            </button>
          </div>
        </div>
      </header>

      <StatusBanner status={status} retrying={retrying} onRetry={retry} />

      {/* role=log 는 붙는 것만 읽는다. 흐르는 동안에는 aria-busy 로 조각마다 읽지 않게
          막고, 끝은 아래 status 한 줄이 알린다. */}
      <div
        className="chat-message-list"
        ref={listRef}
        role="log"
        aria-label="대화"
        aria-relevant="additions"
        aria-busy={streamingHere || undefined}
      >
        <div className="chat-message-list-inner" ref={listInnerRef}>
          {!hasMessages ? (
            <div className="chat-empty-state chat-empty-state-greeting">
              <h1 className="empty-greeting">무엇을 도와드릴까요?</h1>
              {/* Reads the conversation's own model, so switching it in the
                  sidebar updates this chip immediately. */}
              <button
                type="button"
                className="empty-model-chip"
                aria-label={`모델 ${modelLabel} — 모델 바꾸기`}
                onClick={openModelSelector}
              >
                모델 · {modelLabel}
                <ChevronDownIcon aria-hidden="true" />
              </button>
            </div>
          ) : (
            (() => {
              // 다시 생성·다시 시도는 마지막 답에만, 고쳐 보내기는 마지막 질문에만 — 서버가 그 자리만
              // 잘라 다시 돌린다. 답이 흐르는 동안에는 셋 다 내놓지 않는다.
              const messages = activeConversation.messages;
              const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
              const last = messages[messages.length - 1];
              const latestAnswerId = last?.role === "assistant" ? last.id : null;
              const conversationId = activeConversation.id;
              const idle = !isStreaming;
              const expectsReasoning = activeConversation.settings.reasoningLevel !== "off" || selectedEntry?.reasoningFixed === true;
              return messages.map((message, index) => {
                const isLatest = message.id === latestAnswerId;
                return (
                  <MessageItem
                    key={message.id}
                    conversationId={conversationId}
                    message={message}
                    isLatest={isLatest}
                    expectsReasoning={expectsReasoning}
                    mcpServerNames={mcpServerNames}
                    onRegenerate={isLatest && idle && !message.error ? () => regenerateLast(conversationId) : undefined}
                    onRetry={isLatest && idle && message.error ? () => regenerateLast(conversationId) : undefined}
                    onEdit={
                      index === lastUserIndex && idle ? (content: string) => editLastAndResend(conversationId, content) : undefined
                    }
                  />
                );
              });
            })()
          )}
          {remoteCompaction && (
            <div className="message-row assistant">
              <span className="message-avatar waiting" aria-hidden="true" />
              <div className="message-bubble">
                <CompactionProgress kind={remoteCompaction.kind} progress={remoteCompaction.progress} />
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="visually-hidden" role="status">
        {turnAnnouncement}
      </p>

      <div ref={dockRef} className="composer-dock">
        {/* 끝에서 64px 넘게 떨어져 있으면 언제든. 답이 흐르는 중에 따라가지 않고 있으면
            그 아래에 새 글이 붙고 있다는 뜻이라 "새 내용" 이라고 말해 준다. */}
        {showJumpToBottom &&
          (streamingHere ? (
            <button type="button" className="chat-jump-bottom chat-jump-pill" onClick={scrollToBottom}>
              <ArrowDownIcon />
              새 내용
            </button>
          ) : (
            <button
              type="button"
              className="chat-jump-bottom"
              data-tooltip="맨 아래로"
              aria-label="맨 아래로"
              onClick={scrollToBottom}
            >
              <ArrowDownIcon />
            </button>
          ))}
        <ScheduleBanner conversationId={activeConversation.id} />
        <AnswerNowButton
          show={showAnswerNowIdle || answerNowPending}
          pending={answerNowPending}
          onClick={requestAnswerNow}
        />
        <Composer
          conversation={activeConversation}
          kind={kind}
          reasoningFixed={selectedEntry?.reasoningFixed === true}
          isStreaming={isStreaming}
          compacting={compacting}
          attachments={attachments}
          onSend={(text, attachmentIds) => {
            // Sending is a deliberate move to the end of the transcript, not a
            // stream append, so it re-arms following even if the user had
            // scrolled away from the previous answer.
            scrollToBottom();
            sendMessage(activeConversation.id, text, attachmentIds);
          }}
          onStop={handleStop}
          onOpenLibrary={onOpenLibrary}
          onOpenTools={onOpenTools}
          showStarters={!hasMessages}
        />
        {hasMessages && <p className="composer-disclaimer">AI 답변은 틀릴 수 있습니다. 중요한 내용은 원문으로 확인해 주세요.</p>}
      </div>
      <div className="composer-spacer" aria-hidden="true" />

    </div>
  );
}
