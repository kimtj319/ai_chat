import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { embeddingJson } from "../state/embedding";
import type { ClientChatMessage } from "../state/types";
import { CopyButton } from "./CopyButton";
import { EmbeddingResult } from "./EmbeddingResult";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { citationSources } from "../state/citations";
import { friendlyError } from "../state/friendlyError";
import { partitionNotice, visibleNotice } from "../state/visibleNotice";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { MessageAttachments } from "./MessageAttachments";
import { ThinkingPanel } from "./ThinkingPanel";
import { ToolUsagePanel } from "./ToolUsagePanel";
import { BrowserActivity } from "./BrowserActivity";
import "./MessageItem.css";
import { CompactionProgress } from "./CompactionProgress";

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

/** 마지막 사용자 메시지를 그 자리에서 고친다. 보내기는 고친 글로 다시 실행. */
function MessageEditor({
  initial,
  allowEmpty,
  onCancel,
  onSubmit,
}: {
  initial: string;
  /** 첨부만 있는 메시지는 글 없이도 보낼 수 있다. */
  allowEmpty: boolean;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  // 폰·태블릿에는 Shift 가 없으니 Enter 는 줄바꿈, 보내기는 단추로 한다(Composer 와 같다).
  const touch = useMediaQuery("(pointer: coarse)");
  const canSend = allowEmpty || draft.trim().length > 0;

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

export function MessageItem({
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
  const notice = partitionNotice(visibleNotice(message.notice));
  // 사용자가 멈춘 답은 null — 오류 카드를 그리지 않는다.
  const errorText = message.error ? friendlyError(message.error) : null;
  // An embedding turn has no prose to render, and no completion tokens to
  // report — the result panel below carries both the numbers and the usage.
  const embedding = !isUser ? message.embedding : undefined;
  // 문서 검색 결과에 매긴 번호. 서버가 모델에게 보여 준 번호와 같은 규칙으로 센다
  // (state/citations.ts) — 스트리밍 중에는 도구 결과가 아직 없어 끝나면 링크가 된다.
  const citations = useMemo(() => (isUser ? [] : citationSources(message.toolResults)), [isUser, message.toolResults]);
  const hasAttachments = Boolean(message.attachments && message.attachments.length > 0);

  // 바닥줄은 짧게("4.6초 · 276 토큰"), 자세한 값은 툴팁과 화면 읽기 프로그램에.
  const usage = message.usage;
  const hasMeta = !embedding && (usage !== undefined || message.durationMs !== undefined);
  const shortMeta = [
    message.durationMs !== undefined ? formatDuration(message.durationMs) : null,
    usage ? `${usage.completionTokens.toLocaleString()} 토큰` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const fullMeta = [
    usage ? `프롬프트 ${usage.promptTokens.toLocaleString()}` : null,
    usage ? `완성 ${usage.completionTokens.toLocaleString()}` : null,
    message.durationMs !== undefined ? `처리 시간 ${formatDuration(message.durationMs)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
          답변을 생성하는 중…
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
          allowEmpty={hasAttachments}
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
    </div>
  );
}
