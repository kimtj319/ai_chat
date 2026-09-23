import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../api/types";
import { attachmentLimitsFor } from "../attachments/limits";
import { DROP_SUBTITLE, DROP_TITLE } from "../attachments/messages";
import { useAttachmentDraft } from "../hooks/useAttachmentDraft";
import type { useChatStream } from "../hooks/useChatStream";
import { useFileDrop } from "../hooks/useFileDrop";
import { useHealthCheck } from "../hooks/useHealthCheck";
import { conversationTokenTotals } from "../state/conversationOps";
import { shouldShowAnswerNowButton } from "../state/answerNow";
import { capabilityOf, kindOf } from "../state/modelCapability";
import { conversationHistoryFile, downloadJson } from "../state/exportImport";
import { exportConversationPdf } from "../state/pdfExport";
import { pushOverlay } from "../ui/overlayStack";
import { showErrorToast, showToast } from "./Toast";
import { useStore, useActiveConversation } from "../state/StoreContext";
import type { ClientChatMessage } from "../state/types";
import { AnswerNowButton } from "./AnswerNowButton";
import { ConversationSettingsPanel } from "./ConversationSettingsPanel";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { shortModelName } from "./ModelSelector";
import { useModels } from "../hooks/useModels";
import { StatusBanner } from "./StatusBanner";
import { ToolsPanel } from "./ToolsPanel";
import "./ChatView.css";

/** How close to the end still counts as "at the bottom".
 *  Wide enough that a chunk landing between the follow scroll and the scroll
 *  event it fires cannot read as the user having moved: a chunk is one token,
 *  which is a line of text at the very most. */
const BOTTOM_THRESHOLD_PX = 64;

interface ChatViewProps {
  chatStream: ReturnType<typeof useChatStream>;
  /** Null for everyone who is not an administrator, which hides the shortcut. */
  onOpenAdmin: (() => void) | null;
  showConversationSettings: boolean;
  showToolsPanel: boolean;
  onCloseConversationSettings: () => void;
  onCloseToolsPanel: () => void;
  /** Opens the 라이브러리 page, from the composer's MCP picker. */
  onOpenLibrary: () => void;
  /** Opens the 문의 게시판 page, from the header. */
  onOpenBoard: () => void;
}

function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/* 말풍선 안에 줄 두 개 — 게시판은 결국 오가는 말이다. 방패(관리)·연필(새 대화)과
   실루엣이 겹치지 않아 나란히 놓여도 셋이 구분된다. */
function BoardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
      <path d="M8.5 10h7" />
      <path d="M8.5 13.5h4.5" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.4-7.5 9.5-4.4-1.1-7.5-5.1-7.5-9.5V6Z" />
      <path d="M9.5 12l1.8 1.8 3.4-3.6" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.4 11.1 12.3 20.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5" />
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

/** Drop client-only streaming fields before exporting a conversation to JSON.
 *  This destructures an explicit field list, so a new persisted field has to
 *  be named here or the export silently drops it. */
function toExportableMessage(message: ClientChatMessage): ChatMessage {
  const { id, role, content, attachments, reasoning, toolCalls, toolResults, usage, durationMs, error, contentPromotedFromReasoning, createdAt } =
    message;
  return { id, role, content, attachments, reasoning, toolCalls, toolResults, usage, durationMs, error, contentPromotedFromReasoning, createdAt };
}

export function ChatView({
  chatStream,
  onOpenAdmin,
  showConversationSettings,
  showToolsPanel,
  onCloseConversationSettings,
  onCloseToolsPanel,
  onOpenLibrary,
  onOpenBoard,
}: ChatViewProps) {
  const { createConversation } = useStore();
  // 메시지를 그리는 쪽이라 흐르는 값을 직접 읽는다 — 토큰마다 다시 그려지는 것이 여기서는 제 일이다.
  const { activeConversation, activeConversationLoading, activeConversationError } = useActiveConversation();
  // A conversation with an empty `model` uses whatever the server defaults to,
  // which is the first entry of the catalog — show that name rather than blank.
  const { models, catalog, current } = useModels();
  const { isStreaming, sendMessage, stopGeneration, turnStartedAt, answerNowAfterMs, answerNowState, answerStreaming, requestAnswerNow } =
    chatStream;
  const { status, recheck } = useHealthCheck();
  const listRef = useRef<HTMLDivElement>(null);
  const listInnerRef = useRef<HTMLDivElement>(null);

  // 다운로드 형식 선택(JSON / PDF). 바깥을 누르거나 Esc 면 닫힌다.
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadRef = useRef<HTMLDivElement>(null);
  useEffect(() => (downloadOpen ? pushOverlay() : undefined), [downloadOpen]);
  useEffect(() => {
    if (!downloadOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (downloadRef.current && !downloadRef.current.contains(event.target as Node)) setDownloadOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDownloadOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [downloadOpen]);

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

  // Whether the transcript is still chasing the end of the answer. A ref, not
  // state: the scroll listener writes it on every scroll event and the append
  // effect reads it on every streamed chunk, and neither wants a render. The
  // jump button is the only thing on screen that changes with it, so that gets
  // the one piece of state.
  const followBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    followBottomRef.current = true;
    setShowJumpToBottom(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  // Keyed on the conversation because ChatView's first render has no
  // conversation yet and so no list to listen to; the node arrives later.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // A programmatic scroll fires the same `scroll` event as a user's, so this
    // does not try to tell the two apart — it asks the live DOM where the view
    // sits now, and the threshold above is what makes our own scroll (which
    // lands at the end) re-arm rather than disarm. The alternative, flagging
    // the moments around `scrollTop = scrollHeight`, has to guess how long the
    // browser takes to dispatch the event, and it dispatches late under
    // exactly the heavy streaming this has to survive.
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
      followBottomRef.current = atBottom;
      setShowJumpToBottom(!atBottom);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [conversationId]);

  // Another conversation opens at its end with following armed, whatever the
  // last one was left at. Declared above the append effect so a switch re-arms
  // before that effect decides whether to scroll.
  useEffect(() => {
    followBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [conversationId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !followBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [activeConversation?.messages, activeConversation?.id]);

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
          <StatusBanner status={status} onRetry={recheck} />
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

  const totals = conversationTokenTotals(activeConversation.messages);
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

  return (
    <div className={`chat-view${hasMessages ? " has-messages" : ""}`} {...dropHandlers}>

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
          <div className="chat-header-left">
            {totals.totalTokens > 0 && (
              <span className="chat-header-usage">
                프롬프트 {totals.promptTokens.toLocaleString()} · 완성 {totals.completionTokens.toLocaleString()} · 합계{" "}
                {totals.totalTokens.toLocaleString()} 토큰
              </span>
            )}
          </div>
          <div className="chat-header-right">
            {/* Disabled until there is something to save, so pressing it on a
                fresh conversation cannot write an empty file. */}
            <div className="chat-download" ref={downloadRef}>
              <button
                type="button"
                className="btn-icon"
                data-tooltip={pdfBusy ? "PDF 만드는 중…" : "대화 기록 저장"}
                aria-label="대화 기록 저장"
                aria-haspopup="menu"
                aria-expanded={downloadOpen}
                disabled={!hasMessages || pdfBusy}
                onClick={() => setDownloadOpen((open) => !open)}
              >
                <DownloadIcon />
              </button>
              {downloadOpen && (
                <div className="chat-download-menu" role="menu" aria-label="저장 형식">
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-download-option"
                    onClick={() => {
                      setDownloadOpen(false);
                      downloadJson(
                        `${activeConversation.title}.json`,
                        conversationHistoryFile(
                          // "" on the record means "use the server default", which tells a
                          // reader of the file nothing. Name the model that actually
                          // answered — the same one the header shows.
                          { ...activeConversation, model: activeConversation.model || models[0] || "" },
                          activeConversation.messages.map(toExportableMessage),
                        ),
                      );
                    }}
                  >
                    <span className="chat-download-format">JSON</span>
                    <span className="chat-download-hint">대화 기록 데이터</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-download-option"
                    onClick={() => {
                      setDownloadOpen(false);
                      const inner = listInnerRef.current;
                      if (!inner) return;
                      setPdfBusy(true);
                      exportConversationPdf(inner, `${activeConversation.title}.pdf`)
                        .then(() => showToast("PDF 로 저장했습니다."))
                        .catch(showErrorToast)
                        .finally(() => setPdfBusy(false));
                    }}
                  >
                    <span className="chat-download-format">PDF</span>
                    <span className="chat-download-hint">화면과 같은 모습</span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn-icon"
              data-tooltip="새 대화 시작"
              aria-label="새 대화 시작"
              onClick={() => void createConversation()}
            >
              <ComposeIcon />
            </button>
            <button
              type="button"
              className="btn-icon"
              data-tooltip="문의 게시판"
              aria-label="문의 게시판"
              onClick={onOpenBoard}
            >
              <BoardIcon />
            </button>
            {onOpenAdmin && (
              <button
                type="button"
                className="btn-icon"
                data-tooltip="계정 관리"
                aria-label="계정 관리"
                onClick={onOpenAdmin}
              >
                <ShieldIcon />
              </button>
            )}
          </div>
        </div>
      </header>

      <StatusBanner status={status} onRetry={recheck} />

      <div className="chat-message-list" ref={listRef}>
        <div className="chat-message-list-inner" ref={listInnerRef}>
          {!hasMessages ? (
            <div className="chat-empty-state chat-empty-state-greeting">
              <h1 className="empty-greeting">안녕하세요</h1>
              <p className="empty-subtitle">
                {kind === "embedding" ? "임베딩할 텍스트를 입력해보세요." : "무엇이 궁금하신가요?"}
              </p>
              {/* Reads the conversation's own model, so switching it in the
                  sidebar updates this line immediately. */}
              <p className="empty-model-note">
                현재 <strong>{shortModelName(activeConversation.model || models[0] || "")}</strong>이(가) 선택되어 있습니다
              </p>
            </div>
          ) : (
            activeConversation.messages.map((message) => (
              <MessageItem key={message.id} conversationId={activeConversation.id} message={message} />
            ))
          )}
        </div>
      </div>

      <div className="composer-dock">
        {/* Only while an answer is still arriving: once it has finished there
            is nothing left to chase, and where the user parked the view is
            theirs to keep. */}
        {isStreaming && showJumpToBottom && (
          <button
            type="button"
            className="chat-jump-bottom"
            data-tooltip="맨 아래로"
            aria-label="맨 아래로"
            onClick={scrollToBottom}
          >
            <ArrowDownIcon />
          </button>
        )}
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
          attachments={attachments}
          onSend={(text, attachmentIds) => {
            // Sending is a deliberate move to the end of the transcript, not a
            // stream append, so it re-arms following even if the user had
            // scrolled away from the previous answer.
            scrollToBottom();
            sendMessage(activeConversation.id, text, attachmentIds);
          }}
          onStop={stopGeneration}
          onOpenLibrary={onOpenLibrary}
        />
      </div>
      <div className="composer-spacer" aria-hidden="true" />

      {showConversationSettings && (
        <ConversationSettingsPanel conversation={activeConversation} onClose={onCloseConversationSettings} />
      )}
      {showToolsPanel && <ToolsPanel conversation={activeConversation} onClose={onCloseToolsPanel} />}
    </div>
  );
}
