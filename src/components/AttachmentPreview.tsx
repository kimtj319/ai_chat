import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import "./AttachmentPreview.css";

export type PreviewTarget =
  | { kind: "image"; name: string; src: string }
  /** `text` for a draft we already decoded, `url` for one the server holds. */
  | { kind: "text"; name: string; text?: string; url?: string };

interface AttachmentPreviewProps {
  target: PreviewTarget;
  onClose: () => void;
}

/**
 * Wraps the existing Modal, which already brings role="dialog", Esc, the
 * overlay click and the Korean 닫기 button. Text is fetched when the preview
 * opens rather than held in state — a transcript of twenty CSVs should not
 * keep twenty of them in memory.
 */
export function AttachmentPreview({ target, onClose }: AttachmentPreviewProps) {
  const [text, setText] = useState<string | null>(target.kind === "text" ? (target.text ?? null) : null);
  const [error, setError] = useState<string | null>(null);

  const url = target.kind === "text" ? target.url : undefined;
  const hasText = target.kind === "text" && target.text !== undefined;

  useEffect(() => {
    if (!url || hasText) return;
    let cancelled = false;
    setError(null);
    fetch(url, { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch(() => {
        if (!cancelled) setError("첨부를 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [url, hasText]);

  return (
    <Modal title={target.name} onClose={onClose} size="wide">
      {target.kind === "image" ? (
        <img className="attachment-preview-image" src={target.src} alt={target.name} />
      ) : error ? (
        <p className="message-error">{error}</p>
      ) : text === null ? (
        <p className="attachment-preview-loading">불러오는 중…</p>
      ) : (
        <pre className="attachment-preview-text">{text}</pre>
      )}
    </Modal>
  );
}
