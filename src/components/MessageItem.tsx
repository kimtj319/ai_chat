import { embeddingJson } from "../state/embedding";
import type { ClientChatMessage } from "../state/types";
import { CopyButton } from "./CopyButton";
import { EmbeddingResult } from "./EmbeddingResult";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageAttachments } from "./MessageAttachments";
import { ThinkingPanel } from "./ThinkingPanel";
import { ToolUsagePanel } from "./ToolUsagePanel";
import "./MessageItem.css";

interface MessageItemProps {
  /** Needed to address the message's attachments on the server. */
  conversationId: string;
  message: ClientChatMessage;
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

export function MessageItem({ conversationId, message }: MessageItemProps) {
  const isUser = message.role === "user";
  // An embedding turn has no prose to render, and no completion tokens to
  // report — the result panel below carries both the numbers and the usage.
  const embedding = !isUser ? message.embedding : undefined;

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      {/* message-status 의 "답변을 생성하는 중…" 과 같은 조건(message.streaming)에
          묶어, 아바타의 커서 깜빡임이 그 표시와 항상 같이 켜지고 같이 꺼진다. */}
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

      <div className="message-bubble">
        {!isUser && <ThinkingPanel message={message} />}

        {!isUser && <ToolUsagePanel message={message} />}

        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments conversationId={conversationId} attachments={message.attachments} />
        )}

        {isUser ? (
          // May be empty: an image on its own is a complete turn.
          message.content.length > 0 ? (
            <p className="message-plain-text">{message.content}</p>
          ) : null
        ) : embedding ? (
          <EmbeddingResult embedding={embedding} usage={message.usage} />
        ) : message.content.length > 0 ? (
          <MarkdownRenderer content={message.content} />
        ) : null}

        {message.contentPromotedFromReasoning && (
          <p className="message-note">이 응답은 reasoning 필드에서 복원되었습니다.</p>
        )}

        {message.notice && <p className="message-note">{message.notice}</p>}

        {message.error && <p className="message-error">{message.error}</p>}
      </div>

      {/* Kept outside .message-bubble: inside, the user bubble's background and
          padding wrapped the copy button too, inflating the bubble well past
          the query text. The bubble now holds only the message itself. */}
      <div className="message-footer">
        {(message.usage || message.durationMs !== undefined) && !embedding && (
          <span className="message-usage">
            {message.usage && (
              <span>
                프롬프트 {message.usage.promptTokens.toLocaleString()} · 완성{" "}
                {message.usage.completionTokens.toLocaleString()} 토큰
              </span>
            )}
            {/* Under the token line, on its own row: what the request cost and
                how long it took are two different questions about the turn. */}
            {message.durationMs !== undefined && <span>처리 시간 {formatDuration(message.durationMs)}</span>}
          </span>
        )}
        <div className="message-actions">
          {/* Copying an embedding turn has to yield the vector, not the empty
              content field. */}
          <CopyButton text={embedding ? embeddingJson(embedding) : message.content} label="복사" />
        </div>
      </div>
    </div>
  );
}
