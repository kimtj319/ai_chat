import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { setMessageFeedback } from "../api/client";
import type { MessageFeedback } from "../api/types";
import { embeddingJson } from "../state/embedding";
import type { ClientChatMessage } from "../state/types";
import { CopyButton } from "./CopyButton";
import { EmbeddingResult } from "./EmbeddingResult";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { citationSources } from "../state/citations";
import { errorMessage, friendlyError, isUserStop } from "../state/friendlyError";
import { partitionNotice, visibleNotice } from "../state/visibleNotice";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { MessageAttachments } from "./MessageAttachments";
import { ThinkingPanel } from "./ThinkingPanel";
import { ToolUsagePanel } from "./ToolUsagePanel";
import { DocumentDownloads } from "./DocumentDownload";
import { BrowserActivity } from "./BrowserActivity";
import "./MessageItem.css";
import { CompactionProgress } from "./CompactionProgress";
import { showToast } from "./Toast";

interface MessageItemProps {
  /** Needed to address the message's attachments on the server. */
  conversationId: string;
  message: ClientChatMessage;
  /** 공유 링크로 연 대화에서만 — 첨부를 사본에서 받는다. */
  attachmentUrlFor?: (attachmentId: string) => string;
  /**
   * 대화의 가장 최근 답(assistant)이면 true. 그 답의 바닥줄(시간·토큰·버튼)은
   * 늘 보이고, 그 밖의 메시지는 올려 두거나 포커스가 들어올 때만 보인다.
   */
  isLatest?: boolean;
  /** 마지막 답을 다시 만든다. 주면 그 답의 버튼 줄에 '다시 생성' 이 생긴다. */
  onRegenerate?: () => void;
  /** 오류로 끝난 답을 다시 시도한다. 주면 오류 카드에 [다시 시도] 가 생긴다. */
  onRetry?: () => void;
  /** 마지막 사용자 메시지를 고쳐 다시 보낸다. 주면 연필 버튼이 생긴다. */
  onEdit?: (content: string) => void;
  /** 이 턴이 생각하는지(추론 수준 'off' 가 아님). 주면 생각이 오기 전부터 머리줄이 선다. */
  expectsReasoning?: boolean;
  /** MCP 서버 slug → 표시 이름. 도구 사용 줄이 "<이름> 사용" 으로 쓴다. */
  mcpServerNames?: Record<string, string>;
}

/**
 * Seconds for anything a person waited through, minutes once that stops being
 * readable. Sub-second turns are the tool-less trivial ones and still read
 * better as "0.4초" than as a bare millisecond count.
 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
}

function RegenerateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  );
}

function ThumbUpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.4 21H7" />
    </svg>
  );
}

function ThumbDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Zm0 0-4 7a2.5 2.5 0 0 1-2.5-2.5V15H5.3a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 6.6 3H17" />
    </svg>
  );
}

/** 👎 뒤에 열리는 짧은 이유 칸. 비워 두고 닫아도 👎 는 그대로 남는다. */
function FeedbackReason({ onSubmit, onClose }: { onSubmit: (reason: string) => Promise<boolean>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.closest("form")?.scrollIntoView({ block: "nearest" });
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = reason.trim();
    if (!text) {
      onClose();
      return;
    }
    if (await onSubmit(text)) {
      showToast("의견을 보냈습니다. 고맙습니다.");
      onClose();
    }
  }

  return (
    <form className="message-feedback-reason" onSubmit={submit}>
      <input
        ref={inputRef}
        type="text"
        value={reason}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          // Esc 는 이 칸만 닫는다 — 전역 Esc(답변 멈춤)까지 가지 않게.
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder="무엇이 아쉬웠나요? (선택)"
        aria-label="아쉬운 점 (선택)"
      />
      <button type="submit" className="btn btn-secondary btn-sm">
        보내기
      </button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
        닫기
      </button>
    </form>
  );
}

/** 마지막 사용자 메시지를 그 자리에서 고친다. 보내기는 고친 글로 다시 실행. */
function MessageEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  // 폰·태블릿에는 Shift 가 없으니 Enter 는 줄바꿈, 보내기는 단추로 한다(Composer 와 같다).
  const touch = useMediaQuery("(pointer: coarse)");
  // 빈 글은 보내지 않는다 — 고쳐 보내기(editLastAndResend)도 빈 글은 받지 않는다. 첨부만
  // 있는 질문을 글 없이 다시 돌리려면 '다시 생성' 을 쓴다.
  const canSend = draft.trim().length > 0;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 커서는 글 끝에 — 고치는 것은 대개 덧붙이거나 끝을 바꾸는 것이다.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, []);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    onSubmit(draft.trim());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    // 한글을 조합하는 중의 Enter 는 글자를 끝내는 것이지 보내라는 것이 아니다.
    if (event.nativeEvent.isComposing || touch) return;
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  }

  return (
    <form className="message-edit" onSubmit={submit}>
      <textarea
        ref={inputRef}
        className="message-edit-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="메시지 수정"
        rows={Math.min(8, Math.max(2, draft.split("\n").length))}
        autoFocus
      />
      <div className="message-edit-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend}>
          보내기
        </button>
      </div>
    </form>
  );
}

function MessageItemView({
  conversationId,
  message,
  attachmentUrlFor,
  isLatest,
  onRegenerate,
  onRetry,
  onEdit,
  expectsReasoning,
  mcpServerNames,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  // 👍/👎: 화면을 먼저 바꾸고, 저장이 실패하면 되돌린다. 서버가 메시지에 저장하므로 다시
  // 열어도 그대로 보인다(같은 단추를 다시 누르면 지운다).
  const [rating, setRating] = useState<MessageFeedback["rating"] | null>(message.feedback?.rating ?? null);
  const [askingReason, setAskingReason] = useState(false);
  const downRef = useRef<HTMLButtonElement>(null);
  const notice = partitionNotice(visibleNotice(message.notice));
  // 사용자가 멈춘 답은 null — 오류 카드를 그리지 않는다.
  const errorText = message.error ? friendlyError(message.error) : null;
  // 멈춘 답은 실패가 아니라 "중지됨" 이다. 예전에 저장된 답은 stopped 대신 멈춤 문구를
  // error 로 들고 있다 — 둘 다 같은 모양으로 보인다.
  const stopped = !isUser && !message.streaming && (message.stopped === true || isUserStop(message.error));
  // An embedding turn has no prose to render, and no completion tokens to
  // report — the result panel below carries both the numbers and the usage.
  const embedding = !isUser ? message.embedding : undefined;
  // 문서 검색 결과에 매긴 번호. 서버가 모델에게 보여 준 번호와 같은 규칙으로 센다
  // (state/citations.ts) — 스트리밍 중에는 도구 결과가 아직 없어 끝나면 링크가 된다.
  const citations = useMemo(() => (isUser ? [] : citationSources(message.toolResults)), [isUser, message.toolResults]);
  const hasAttachments = Boolean(message.attachments && message.attachments.length > 0);

  // 바닥줄은 짧게("4.6초 · 12,345 토큰"), 자세한 값은 툴팁과 화면 읽기 프로그램에.
  // 토큰은 이 답에 실제로 쓴 전체(입력 + 출력, 도구 라운드·요약·압축·제목 같은 곁 호출까지).
  // 멈춘 답은 모델이 사용량을 끝에만 알려 주어 대개 0 이다 — "0 토큰" 은 틀린 말이라 뺀다.
  const usage = stopped && message.usage?.totalTokens === 0 ? undefined : message.usage;
  const hasMeta = !embedding && (usage !== undefined || message.durationMs !== undefined || stopped);
  const shortMeta = [
    message.durationMs !== undefined ? formatDuration(message.durationMs) : null,
    usage ? `${usage.totalTokens.toLocaleString()} 토큰` : null,
    stopped ? "중지됨" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const fullMeta = [
    stopped ? "사용자가 중지한 답변" : null,
    usage ? `전체 ${usage.totalTokens.toLocaleString()} 토큰` : null,
    usage ? `입력 ${usage.promptTokens.toLocaleString()}` : null,
    usage ? `출력 ${usage.completionTokens.toLocaleString()}` : null,
    message.durationMs !== undefined ? `처리 시간 ${formatDuration(message.durationMs)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // 공유 링크로 연 대화(conversationId 가 비어 있음)는 평가할 수 없다.
  const canRate = !isUser && !embedding && !message.streaming && !errorText && conversationId !== "";

  async function saveFeedback(next: MessageFeedback["rating"] | null, reason?: string): Promise<boolean> {
    const previous = rating;
    setRating(next);
    try {
      await setMessageFeedback(conversationId, message.id, next, reason);
      return true;
    } catch (error) {
      setRating(previous);
      showToast(`평가를 저장하지 못했습니다. ${errorMessage(error)}`, "error");
      return false;
    }
  }

  function chooseFeedback(next: MessageFeedback["rating"]) {
    const value = rating === next ? null : next;
    setAskingReason(value === "down");
    void saveFeedback(value);
  }

  function closeReason() {
    setAskingReason(false);
    downRef.current?.focus();
  }

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      {/* message-status 의 "답변을 생성하는 중…" 과 같은 조건(message.streaming)에
          묶어, 아바타의 ">_" 움직임이 그 표시와 항상 같이 켜지고 같이 꺼진다. */}
      {!isUser && (
        <span
          className={`message-avatar${message.streaming ? " waiting" : ""}`}
          aria-hidden="true"
        />
      )}

      {/* Pinned beside the avatar for the whole stream, not only while the
          content is empty, so the status never moves or disappears as the
          thinking/tool panels and the answer fill in below it. */}
      {!isUser && message.streaming && (
        <span className="message-status thinking-shimmer" role="status" aria-label="응답 생성 중">
          {message.queuedAhead !== undefined
            ? `사용자가 많아 차례를 기다리는 중…${message.queuedAhead > 0 ? ` (앞에 ${message.queuedAhead}명)` : ""}`
            : "답변을 생성하는 중…"}
        </span>
      )}

      {/* 고치는 동안 사용자 말풍선에는 첨부만 남는다(첨부는 그대로 다시 보낸다). */}
      {!(editing && !hasAttachments) && (
        <div className="message-bubble">
          {!isUser && <ThinkingPanel message={message} expectsReasoning={expectsReasoning} />}

          {!isUser && <ToolUsagePanel message={message} mcpServerNames={mcpServerNames} />}

          {!isUser && message.compaction && (
            <CompactionProgress kind={message.compaction.kind} progress={message.compaction.progress} />
          )}

          {/* 모델이 크롬에서 본 화면. 이 브라우저에서 찍힌 것만 있다(새로고침하면 사라진다). */}
          {!isUser && <BrowserActivity toolCalls={message.toolCalls} live={Boolean(message.streaming)} />}

          {hasAttachments && (
            <MessageAttachments conversationId={conversationId} attachments={message.attachments!} urlFor={attachmentUrlFor} />
          )}

          {isUser ? (
            // May be empty: an image on its own is a complete turn.
            message.content.length > 0 && !editing ? (
              <p className="message-plain-text">{message.content}</p>
            ) : null
          ) : embedding ? (
            <EmbeddingResult embedding={embedding} usage={message.usage} />
          ) : message.content.length > 0 ? (
            <MarkdownRenderer content={message.content} citations={citations} streaming={Boolean(message.streaming)} />
          ) : null}

          {/* 모델이 create_document 로 정리한 문서 — 누르면 그 문서만 받는다. */}
          {!isUser && <DocumentDownloads toolCalls={message.toolCalls} toolResults={message.toolResults} />}

          {/* 아무 글도 오기 전에 멈춘 답: 빈 말풍선 대신 한 줄. */}
          {stopped && message.content.length === 0 && !message.reasoning && !message.toolCalls?.length && (
            <p className="message-note">답변을 시작하기 전에 중지했습니다.</p>
          )}

          {message.contentPromotedFromReasoning && (
            <p className="message-note">이 응답은 reasoning 필드에서 복원되었습니다.</p>
          )}

          {/* MCP 서버를 못 쓴 턴: 답보다 눈에 띄지 않게 한 줄로 접고, 펼치면 원문. */}
          {notice.toolFailures.length > 0 && (
            <details className="message-tool-failure">
              <summary>도구 {notice.toolFailures.length}개를 쓰지 못했습니다 · 자세히</summary>
              <p className="message-note">{notice.toolFailures.join("\n")}</p>
            </details>
          )}

          {notice.other && <p className="message-note">{notice.other}</p>}

          {/* 받은 데까지의 답은 위에 그대로 두고, 그 아래에 무엇을 하면 되는지를 쓴다. */}
          {errorText && (
            <div className="message-error">
              <p className="message-error-text">{errorText}</p>
              {onRetry && (
                <button type="button" className="btn btn-secondary btn-sm message-error-retry" onClick={onRetry}>
                  다시 시도
                </button>
              )}
              {errorText !== message.error && (
                <details className="message-error-details">
                  <summary>자세히</summary>
                  <pre>{message.error}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {editing && onEdit && (
        <MessageEditor
          initial={message.content}
          onCancel={() => setEditing(false)}
          onSubmit={(content) => {
            setEditing(false);
            onEdit(content);
          }}
        />
      )}

      {/* Kept outside .message-bubble: inside, the user bubble's background and
          padding wrapped the copy button too, inflating the bubble well past
          the query text. The bubble now holds only the message itself. */}
      {!editing && (
        <div className={`message-footer${!isUser && isLatest ? " pinned" : ""}`}>
          {hasMeta && (
            <span className="message-usage" data-tooltip={fullMeta}>
              <span aria-hidden="true">{shortMeta}</span>
              <span className="visually-hidden">{fullMeta}</span>
            </span>
          )}
          <div className="message-actions">
            {/* Copying an embedding turn has to yield the vector, not the empty
                content field. */}
            <CopyButton text={embedding ? embeddingJson(embedding) : message.content} label="복사" />
            {isUser && onEdit && (
              <button
                type="button"
                className="btn-icon"
                onClick={() => setEditing(true)}
                aria-label="메시지 수정"
                data-tooltip="메시지 수정"
              >
                <PencilIcon />
              </button>
            )}
            {canRate && (
              <>
                <button
                  type="button"
                  className="btn-icon message-feedback"
                  onClick={() => chooseFeedback("up")}
                  aria-pressed={rating === "up"}
                  aria-label="좋은 답변"
                  data-tooltip={rating === "up" ? "좋은 답변 (다시 누르면 취소)" : "좋은 답변"}
                >
                  <ThumbUpIcon />
                </button>
                <button
                  ref={downRef}
                  type="button"
                  className="btn-icon message-feedback"
                  onClick={() => chooseFeedback("down")}
                  aria-pressed={rating === "down"}
                  aria-label="아쉬운 답변"
                  data-tooltip={rating === "down" ? "아쉬운 답변 (다시 누르면 취소)" : "아쉬운 답변"}
                >
                  <ThumbDownIcon />
                </button>
              </>
            )}
            {!isUser && onRegenerate && !message.streaming && (
              <button
                type="button"
                className="btn-icon"
                onClick={onRegenerate}
                aria-label="다시 생성"
                data-tooltip="다시 생성"
              >
                <RegenerateIcon />
              </button>
            )}
          </div>
        </div>
      )}

      {canRate && askingReason && <FeedbackReason onSubmit={(reason) => saveFeedback("down", reason)} onClose={closeReason} />}
    </div>
  );
}

/**
 * 답변이 흘러나오는 동안 대화는 토큰마다 다시 그려진다. 지난 메시지들은 그대로인데도
 * 마크다운·코드 강조·수식을 매번 다시 해석하던 것을 막는다 — 바뀌지 않은 메시지는 같은
 * 객체로 남아 있으므로(StoreContext) 그대로 두면 된다.
 *
 * 콜백은 ChatView 가 그릴 때마다 새로 만들지만 하는 일은 conversationId 에만 달려 있어
 * (같은 대화의 다시 생성·재시도·수정) 있고 없음만 비교한다. conversationId 자체는 비교한다.
 */
function sameProps(a: MessageItemProps, b: MessageItemProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MessageItemProps>;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (typeof x === "function" || typeof y === "function") {
      if (typeof x !== typeof y) return false;
      continue;
    }
    if (!Object.is(x, y)) return false;
  }
  return true;
}

export const MessageItem = memo(MessageItemView, sameProps);
