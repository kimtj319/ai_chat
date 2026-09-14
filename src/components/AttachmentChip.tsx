import type { DraftAttachment } from "../hooks/useAttachmentDraft";
import { formatBytes, formatTokens, middleEllipsis } from "../attachments/format";
import "./AttachmentChip.css";

/** Enough to show both ends of a name plus its extension inside 220px. */
const NAME_MAX_CHARS = 22;

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

function ChipMedia({ item }: { item: DraftAttachment }) {
  if (item.status === "preparing" || item.status === "uploading") {
    return <span className="attachment-chip-spinner" aria-hidden="true" />;
  }
  if (item.kind === "image" && item.previewUrl) {
    return <img src={item.previewUrl} alt="" />;
  }
  return <FileIcon />;
}

function tokenLabel(tokens: number): string {
  return `약 ${formatTokens(tokens)} 토큰`;
}

interface AttachmentChipProps {
  item: DraftAttachment;
  /** True when dropping this one is what gets the draft back under budget. */
  overBudget: boolean;
  onPreview: () => void;
  onRemove: () => void;
  onRetry: () => void;
}

/**
 * One pending attachment. The chip body and the × are *siblings*, never
 * nested: a button inside a button is invalid, and screen readers only ever
 * reach the outer one.
 */
export function AttachmentChip({ item, overBudget, onPreview, onRemove, onRetry }: AttachmentChipProps) {
  const busy = item.status === "preparing" || item.status === "uploading";
  const failed = item.status === "failed";

  return (
    <div
      className="attachment-chip"
      data-status={item.status}
      data-over-budget={overBudget ? "true" : undefined}
      aria-busy={busy || undefined}
      aria-invalid={failed || undefined}
    >
      <button
        type="button"
        className="attachment-chip-body"
        onClick={onPreview}
        disabled={busy}
        title={item.name}
        aria-label={`${item.name} 미리보기`}
      >
        <span className="attachment-chip-media">
          <ChipMedia item={item} />
        </span>
        <span className="attachment-chip-text">
          <span className="attachment-chip-name">{middleEllipsis(item.name, NAME_MAX_CHARS)}</span>
          <span className="attachment-chip-meta">
            {failed ? "업로드 실패" : tokenLabel(item.estimatedTokens)}
            <span className="attachment-chip-bytes"> · {formatBytes(item.bytes)}</span>
          </span>
        </span>
      </button>

      {failed && (
        <button
          type="button"
          className="attachment-chip-action"
          onClick={onRetry}
          aria-label={`${item.name} 다시 올리기`}
          data-tooltip="다시 올리기"
        >
          <RetryIcon />
        </button>
      )}

      <button
        type="button"
        className="attachment-chip-action"
        onClick={onRemove}
        aria-label={overBudget ? `${item.name} 첨부 제거 (한도 초과)` : `${item.name} 첨부 제거`}
        data-tooltip="첨부 제거"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

interface StaticAttachmentChipProps {
  name: string;
  tokens?: number;
  bytes: number;
  onPreview: () => void;
}

/**
 * The sent-message variant: one button, outlined rather than filled — a
 * surface fill on the tinted user bubble goes muddy in dark mode.
 */
export function StaticAttachmentChip({ name, tokens, bytes, onPreview }: StaticAttachmentChipProps) {
  return (
    <button
      type="button"
      className="attachment-chip attachment-chip-static"
      onClick={onPreview}
      title={name}
      aria-label={`${name} 미리보기`}
    >
      <span className="attachment-chip-media">
        <FileIcon />
      </span>
      <span className="attachment-chip-text">
        <span className="attachment-chip-name">{middleEllipsis(name, NAME_MAX_CHARS)}</span>
        <span className="attachment-chip-meta">
          {tokens !== undefined ? tokenLabel(tokens) : "텍스트 파일"}
          <span className="attachment-chip-bytes"> · {formatBytes(bytes)}</span>
        </span>
      </span>
    </button>
  );
}
