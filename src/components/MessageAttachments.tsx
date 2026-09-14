import { useState } from "react";
import { attachmentUrl } from "../api/client";
import type { MessageAttachment } from "../api/types";
import { StaticAttachmentChip } from "./AttachmentChip";
import { AttachmentPreview, type PreviewTarget } from "./AttachmentPreview";
import "./MessageAttachments.css";

interface MessageAttachmentsProps {
  conversationId: string;
  attachments: MessageAttachment[];
}

/**
 * What a sent message shows above its text. No inline excerpt of a text file:
 * the transcript is the conversation, not a file viewer — clicking opens a
 * preview instead.
 */
export function MessageAttachments({ conversationId, attachments }: MessageAttachmentsProps) {
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  if (attachments.length === 0) return null;

  const images = attachments.filter((attachment) => attachment.kind === "image");
  const files = attachments.filter((attachment) => attachment.kind !== "image");

  function openImage(attachment: MessageAttachment) {
    setPreview({ kind: "image", name: attachment.name, src: attachmentUrl(conversationId, attachment.id) });
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
          <img src={attachmentUrl(conversationId, images[0].id)} alt={images[0].name} />
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
              <img src={attachmentUrl(conversationId, attachment.id)} alt={attachment.name} />
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
                  url: attachmentUrl(conversationId, attachment.id),
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
