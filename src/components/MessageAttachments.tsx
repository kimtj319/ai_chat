import { useState } from "react";
import { attachmentUrl } from "../api/client";
import type { MessageAttachment } from "../api/types";
import { StaticAttachmentChip } from "./AttachmentChip";
import { AttachmentPreview, type PreviewTarget } from "./AttachmentPreview";
import "./MessageAttachments.css";

interface MessageAttachmentsProps {
  conversationId: string;
  attachments: MessageAttachment[];
  /** 첨부를 받아 올 주소. 공유 링크로 연 대화는 원본이 아니라 사본에서 받는다. */
  urlFor?: (attachmentId: string) => string;
}

/**
 * What a sent message shows above its text. No inline excerpt of a text file:
 * the transcript is the conversation, not a file viewer — clicking opens a
 * preview instead.
 */
export function MessageAttachments({ conversationId, attachments, urlFor }: MessageAttachmentsProps) {
  const srcOf = urlFor ?? ((attachmentId: string) => attachmentUrl(conversationId, attachmentId));
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  if (attachments.length === 0) return null;

  const images = attachments.filter((attachment) => attachment.kind === "image");
  const files = attachments.filter((attachment) => attachment.kind !== "image");

  function openImage(attachment: MessageAttachment) {
    setPreview({ kind: "image", name: attachment.name, src: srcOf(attachment.id) });
  }

  return (
    <div className="message-attachments">
      {images.length === 1 && images[0] ? (
        <button
          type="button"
          className="message-attachment-single"
          onClick={() => openImage(images[0] as MessageAttachment)}
          aria-label={`${images[0].name} 미리보기`}
          data-tooltip="크게 보기"
        >
          <img src={srcOf(images[0].id)} alt={images[0].name} />
        </button>
      ) : images.length > 1 ? (
        <div className="message-attachment-grid">
          {images.map((attachment) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => openImage(attachment)}
              aria-label={`${attachment.name} 미리보기`}
              data-tooltip="크게 보기"
            >
              <img src={srcOf(attachment.id)} alt={attachment.name} />
            </button>
          ))}
        </div>
      ) : null}

      {files.length > 0 && (
        <div className="message-attachment-files">
          {files.map((attachment) => (
            <StaticAttachmentChip
              key={attachment.id}
              name={attachment.name}
              tokens={attachment.estimatedTokens}
              bytes={attachment.bytes}
              onPreview={() =>
                setPreview({
                  kind: "text",
                  name: attachment.name,
                  url: srcOf(attachment.id),
                })
              }
            />
          ))}
        </div>
      )}

      {preview && <AttachmentPreview target={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
