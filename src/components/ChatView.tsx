import { ModelSelector } from "./ModelSelector";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attachmentLimitsFor } from "../attachments/limits";
import { DROP_SUBTITLE, DROP_TITLE } from "../attachments/messages";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import type { useChatStream } from "../hooks/useChatStream";
import { useFileDrop } from "../hooks/useFileDrop";
import { useFollowBottom } from "../hooks/useFollowBottom";
import { useHealthCheck } from "../hooks/useHealthCheck";
import { shouldShowAnswerNowButton } from "../state/answerNow";
import { isUserStop } from "../state/friendlyError";
import { capabilityOf, kindOf } from "../state/modelCapability";
import { useStore, useActiveConversation } from "../state/StoreContext";
import type { ClientChatMessage } from "../state/types";
import { AnswerNowButton } from "./AnswerNowButton";
import { Composer } from "./Composer";
import { ConversationExportActions } from "./ConversationExportActions";
import { MessageItem } from "./MessageItem";
import { useModels } from "../hooks/useModels";
import { useMcpLibrary } from "../hooks/useMcpLibrary";
import { useRemoteCompaction } from "../hooks/useRemoteCompaction";
import { StatusBanner } from "./StatusBanner";
import { ScheduleBanner } from "./ScheduleBanner";
import { CompactionProgress } from "./CompactionProgress";
import { BoardIcon, PaperclipIcon } from "./icons";
import "./ChatView.css";
import { prefetchBoardList } from "../state/boardCache";
import { NoticeButton } from "./NoticeButton";
import { SourceLinks } from "./SourceLinks";
import { SourcePicker } from "./SourcePicker";
import { useScrollKeys } from "../hooks/useScrollKeys";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { showErrorToast } from "./Toast";

interface ChatViewProps {
  chatStream: ReturnType<typeof useChatStream>;
  /** Opens the 라이브러리 page, from the composer's MCP picker. */
  onOpenLibrary: () => void;
  onOpenTools: () => void;
  /** Opens the 문의 게시판 page, from the header. */
  onOpenBoard: () => void;
}

/**
 * 대화 머리 왼쪽의 제목. 누르면 그 자리에서 이름을 고친다(Enter 저장, Esc 취소) —
 * 사이드바까지 가서 줄을 찾지 않아도 된다. 저장은 사이드바와 같은 renameConversation.
 */
function ChatTitle({ title, onRename }: { title: string; onRename: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);

  useEffect(() => {
    // 고치기를 마치면 포커스를 제목 단추로 돌려준다 — 입력칸이 사라지며 body 로 떨어지지 않게.
    if (!editing && returnFocusRef.current) {
      returnFocusRef.current = false;
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  function finish(save: boolean) {
    if (!editing) return;
    returnFocusRef.current = true;
    setEditing(false);
    const next = value.trim();
    if (!save || next.length === 0 || next === title) return;
    onRename(next).catch(showErrorToast);
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="chat-header-title-input"
        aria-label="대화 이름"
        maxLength={200}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          // 한글 조합 중의 Enter 는 글자를 맺는 키다.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            // 출처 창 닫기·생성 중단도 window 에서 Esc 를 듣는다. 이 Esc 는 이름 고치기의 것이다.
            event.nativeEvent.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className="chat-header-title"
      data-tooltip="이름 바꾸기"
      aria-label={`대화 이름 「${title}」 — 바꾸기`}
      onClick={() => {
        setValue(title);
        setEditing(true);
      }}
    >
      {title}
    </button>
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
  const { createConversation, selectConversation, renameConversation, conversations } = useStore();
  // 메시지를 그리는 쪽이라 흐르는 값을 직접 읽는다 — 토큰마다 다시 그려지는 것이 여기서는 제 일이다.
  const { activeConversation, activeConversationLoading, activeConversationError } = useActiveConversation();
  // A conversation with an empty `model` uses whatever the server defaults to,
  // which is the first entry of the catalog — show that name rather than blank.
  const { models, catalog, current } = useModels();
  const { sendMessage, stopGeneration, requestAnswerNow, regenerateLast, editLastAndResend } = chatStream;
  // 도구 줄이 MCP 도구를 "<서버 이름> 사용" 으로 쓰도록 slug → 이름.
  const { servers: mcpServers } = useMcpLibrary();
  const mcpServerNames = useMemo(() => Object.fromEntries(mcpServers.map((server) => [server.slug, server.name])), [mcpServers]);
  const activeId = activeConversation?.id ?? null;
  // 흐르는 상태는 대화마다 따로다. 이 화면은 열린 대화의 턴만 본다 — 다른 대화가 답하는
  // 동안에도 여기서는 보내기·다시 생성이 그대로 되고, 멈춤 단추는 그 대화에만 뜬다.
  const turn = activeId ? chatStream.turns[activeId] : undefined;
  const streamingHere = turn !== undefined;
  const turnStartedAt = turn?.turnStartedAt ?? null;
  const answerNowState = turn?.answerNowState ?? "idle";
  const answerStreaming = turn?.answerStreaming ?? false;
  // 이 페이지가 흘려 받지 않는 압축(새로 고침·다시 열기)은 서버에 묻는다. 끝나면 요약된 대화를 다시 불러온다.
  const remoteCompaction = useRemoteCompaction(activeId, !streamingHere, () => {
    if (activeId) void selectConversation(activeId);
  });
  const compacting = turn?.compacting === true || remoteCompaction !== null;
  const { status, retrying, retry } = useHealthCheck();
  // 폰 폭: 머리의 저장·공유·게시판을 ⋯ 하나로 접는다(ConversationExportActions).
  const compactHeader = useMediaQuery("(max-width: 480px)");
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
    if (!activeId) return;
    stopRequestedRef.current = true;
    stopGeneration(activeId);
  }, [activeId, stopGeneration]);

  // "지금 답변하기" 가 뜰 시각을 알기 위한 재렌더 심장박동. 이미 눌렀으면
  // (answerNowState === "requested") 더 잴 것이 없으니 멈춘다 — 그 뒤로는
  // isStreaming 하나로 배너의 "정리하는 중" 상태가 결정된다.
  const [answerNowNow, setAnswerNowNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streamingHere || turnStartedAt === null || answerNowState === "requested") return;
    const id = window.setInterval(() => setAnswerNowNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [streamingHere, turnStartedAt, answerNowState]);

  const showAnswerNowIdle = shouldShowAnswerNowButton({
    isStreaming: streamingHere,
    turnStartedAt,
    answerNowAfterMs: turn?.answerNowAfterMs ?? 0,
    clicked: answerNowState === "requested",
    answerStreaming,
    now: answerNowNow,
  });
  // 누른 뒤에는(pending) "정리하는 중…" 으로 바뀌어 떠 있다가, 마무리 답변이
  // 흘러나오기 시작하면 사라진다 — 답이 보이는데 "정리하는 중" 을 계속 띄울
  // 이유가 없다.
  const answerNowPending = streamingHere && answerNowState === "requested" && !answerStreaming;

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
  // 첫 답 뒤에 서버가 지어 주는 제목은 목록(요약)만 다시 받아 온다 — 열린 대화의 기록은 "새 대화" 로
  // 남아 있다. 머리는 사이드바와 같은 이름을 보여야 하므로 목록 쪽을 먼저 본다.
  const headerTitle = conversations.find((c) => c.id === activeConversation.id)?.title ?? activeConversation.title;

  // Until the first message lands nothing is locked, so the composer follows
  // the model that is selected right now; after that it follows the
  // conversation's own recorded kind.
  const selectedEntry = catalog.find((entry) => entry.id === (activeConversation.model || current));
  const kind = hasMessages
    ? kindOf(activeConversation.kind)
    : capabilityOf(selectedEntry) === "embedding"
      ? "embedding"
      : "chat";


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
              화면 위쪽에 떠 있는 알약 하나가 둘째 사본이었다. 합계는 저장 메뉴 아래에 둔다.
              왼쪽에는 지금 어느 대화인지(제목)와 어느 모델이 답하는지를 둔다. 빈 대화는
              인사말 아래에 같은 모델 칩이 있어 비워 둔다. */}
          <div className="chat-header-left">
            {hasMessages && (
              <>
                <ChatTitle
                  key={activeConversation.id}
                  title={headerTitle}
                  onRename={(title) => renameConversation(activeConversation.id, title)}
                />
                {/* 누른 자리에서 바로 고른다(ModelSelector). */}
                <ModelSelector triggerClassName="chat-header-model" placement="below" />
              </>
            )}
          </div>
          {/* 답변이 웹 페이지에 기댔을 때만 나타난다. 출처 문서 바로 왼쪽 — 문서 단추가 늘
              서던 자리를 지키고, 둘이 한 무리의 "출처" 로 읽힌다. */}
          <SourceLinks messages={activeConversation.messages} />
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
                collapsedBoard={compactHeader ? { onOpenBoard, onPrefetchBoard: prefetchBoardList } : undefined}
              />
            )}
            <NoticeButton />
            {!(compactHeader && hasMessages) && (
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
            )}
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
              {/* 누른 자리에서 바로 고른다. 사이드바 바닥의 선택기와 같은 대화 모델을 본다. */}
              <ModelSelector triggerClassName="empty-model-chip" placement="below" renderLabel={(name) => `모델 · ${name}`} />
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
              const idle = !streamingHere;
              const expectsReasoning = activeConversation.settings.reasoningLevel !== "off" || selectedEntry?.reasoningFixed === true;
              return messages.map((message, index) => {
                const isLatest = message.id === latestAnswerId;
                // 멈춘 답(예전에 "Cancelled by client." 로 저장된 것 포함)은 실패가 아니다 —
                // 다시 시도 카드가 아니라 다시 생성 단추를 단다.
                const failed = Boolean(message.error) && !isUserStop(message.error);
                return (
                  <MessageItem
                    key={message.id}
                    conversationId={conversationId}
                    message={message}
                    isLatest={isLatest}
                    expectsReasoning={expectsReasoning}
                    mcpServerNames={mcpServerNames}
                    onRegenerate={isLatest && idle && !failed ? () => regenerateLast(conversationId) : undefined}
                    onRetry={isLatest && idle && failed ? () => regenerateLast(conversationId) : undefined}
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
          onClick={() => activeId && requestAnswerNow(activeId)}
        />
        <Composer
          conversation={activeConversation}
          kind={kind}
          reasoningFixed={selectedEntry?.reasoningFixed === true}
          isStreaming={streamingHere}
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
