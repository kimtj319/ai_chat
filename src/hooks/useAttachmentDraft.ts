import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import { AttachmentError } from "../api/client";
import type { AttachmentLimits } from "../api/types";
import { classifyFile, HEAD_BYTES, type AttachmentKind } from "../attachments/classify";
import {
  estimateImageTokens,
  estimateTextTokens,
  fitWithin,
  formatBytes,
  isGenericPastedName,
  MAX_ATTACHMENTS,
  MAX_SOURCE_IMAGE_BYTES,
  pastedImageName,
} from "../attachments/format";
import { decodeImage, prepareImage, type SourceImage } from "../attachments/imagePrepare";
import { downscaleEdge, overBudgetIds } from "../attachments/limits";
import * as copy from "../attachments/messages";
import type { NoticeSpec } from "../attachments/messages";
import { decodeText, TEXT_UPLOAD_MIME, utf8ByteLength } from "../attachments/textDecode";
import { createId } from "../state/defaults";

export type DraftStatus = "preparing" | "uploading" | "ready" | "failed";

export interface DraftAttachment {
  localId: string;
  name: string;
  kind: AttachmentKind;
  status: DraftStatus;
  /** Bytes as they will be uploaded (post-downscale, post-UTF-8). */
  bytes: number;
  /** What the model will actually be charged for this attachment. */
  estimatedTokens: number;
  mime: string;
  width?: number;
  height?: number;
  /** Object URL for the image thumbnail; revoked on removal/send/unmount. */
  previewUrl?: string;
  /** Decoded text, kept so a preview needs no round trip. */
  text?: string;
  /** Server id, present once the upload succeeded. */
  serverId?: string;
  error?: string;
  /** The prepared bytes, kept so a failed upload can be retried as-is. */
  blob?: Blob;
}

export interface AttachmentNotice extends NoticeSpec {
  id: number;
}

export type AttachSource = "picker" | "drop" | "paste";

export interface AttachmentDraft {
  items: DraftAttachment[];
  notice: AttachmentNotice | null;
  totalTokens: number;
  hasPending: boolean;
  hasFailed: boolean;
  /** The draft as a whole is over the per-message budget: sending is blocked. */
  overBudget: boolean;
  /** Which chips a user would drop to get back under the budget. */
  overBudgetIds: Set<string>;
  limits: AttachmentLimits;
  addFiles: (files: Iterable<File>, source: AttachSource) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  clear: () => void;
  readyIds: () => string[];
  dismissNotice: () => void;
  reportSubmitBlocked: () => void;
}

/**
 * The pending attachments for one conversation.
 *
 * Owned by ChatView rather than Composer: neither component is remounted when
 * the user switches conversations, so a draft held in Composer would follow
 * them into the next conversation. Keyed on the conversation id here, the
 * draft (and every object URL and in-flight upload it owns) is torn down the
 * moment that id changes. It is deliberately not in StoreContext either —
 * that holds server state, and this is a local, unsent edit.
 */
export function useAttachmentDraft(conversationId: string, limits: AttachmentLimits): AttachmentDraft {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [notice, setNotice] = useState<AttachmentNotice | null>(null);

  // itemsRef is the source of truth for the async upload callbacks; every
  // write goes through `update` so the two never disagree.
  const itemsRef = useRef<DraftAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const noticeTimer = useRef<number | null>(null);
  const noticeSeq = useRef(0);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  const update = useCallback((fn: (previous: DraftAttachment[]) => DraftAttachment[]) => {
    const next = fn(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (localId: string, changes: Partial<DraftAttachment>) => {
      update((previous) => previous.map((item) => (item.localId === localId ? { ...item, ...changes } : item)));
    },
    [update],
  );

  const discard = useCallback(
    (localId: string) => {
      update((previous) => {
        const target = previous.find((item) => item.localId === localId);
        if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
        return previous.filter((item) => item.localId !== localId);
      });
    },
    [update],
  );

  const raise = useCallback((spec: NoticeSpec) => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, ...spec });
    if (!spec.sticky) {
      noticeTimer.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimer.current = null;
      }, copy.NOTICE_TIMEOUT_MS);
    }
  }, []);

  const dismissNotice = useCallback(() => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(null);
  }, []);

  const reportSubmitBlocked = useCallback(() => raise(copy.submitBlocked()), [raise]);

  // Switching conversations (and unmounting) tears the whole draft down:
  // in-flight uploads aborted, object URLs revoked, chips cleared.
  useEffect(() => {
    const inFlight = controllers.current;
    return () => {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      for (const item of itemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      itemsRef.current = [];
      setItems([]);
      setNotice(null);
      if (noticeTimer.current !== null) {
        clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
    };
  }, [conversationId]);

  const upload = useCallback(
    async (localId: string, conversation: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item?.blob) return;

      const controller = new AbortController();
      controllers.current.set(localId, controller);
      patch(localId, { status: "uploading", error: undefined });

      try {
        const stored = await api.uploadAttachment(conversation, item.name, item.blob, controller.signal);
        if (conversationRef.current !== conversation) return;
        patch(localId, {
          status: "ready",
          serverId: stored.id,
          bytes: stored.bytes,
          // The server's own accounting wins once we have it.
          estimatedTokens: stored.estimatedTokens ?? item.estimatedTokens,
          width: stored.width ?? item.width,
          height: stored.height ?? item.height,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (conversationRef.current !== conversation) return;
        const spec = noticeForUploadError(error, item.name, limitsRef.current);
        patch(localId, { status: "failed", error: spec.text });
        raise(spec);
      } finally {
        controllers.current.delete(localId);
      }
    },
    [patch, raise],
  );

  /** Decode/downscale, then upload. Refusals discovered here drop the chip. */
  const prepareAndUpload = useCallback(
    async (localId: string, file: File, name: string, source: SourceImage, conversation: string) => {
      const active = limitsRef.current;
      try {
        const prepared = await prepareImage(file, source, downscaleEdge(active));
        if (conversationRef.current !== conversation) return;
        if (prepared.width > active.maxImageWidth || prepared.height > active.maxImageHeight) {
          discard(localId);
          raise(copy.imageTooLarge(name, prepared.width, prepared.height, active.maxImageWidth, active.maxImageHeight));
          return;
        }
        if (prepared.blob.size > active.maxFileBytes) {
          discard(localId);
          raise(copy.tooLarge(name, formatBytes(active.maxFileBytes), "image"));
          return;
        }
        patch(localId, {
          blob: prepared.blob,
          previewUrl: URL.createObjectURL(prepared.blob),
          width: prepared.width,
          height: prepared.height,
          bytes: prepared.blob.size,
          estimatedTokens: estimateImageTokens(prepared.width, prepared.height),
          mime: prepared.blob.type || file.type,
        });
      } catch {
        if (conversationRef.current !== conversation) return;
        discard(localId);
        raise(copy.undecodableImage(name));
        return;
      }

      if (conversationRef.current !== conversation) return;
      await upload(localId, conversation);
    },
    [discard, patch, raise, upload],
  );

  const addFiles = useCallback(
    (files: Iterable<File>, source: AttachSource) => {
      void (async () => {
        const conversation = conversationRef.current;

        for (const file of Array.from(files)) {
          if (conversationRef.current !== conversation) return;
          const active = limitsRef.current;

          if (itemsRef.current.length >= MAX_ATTACHMENTS) {
            raise(copy.tooMany(MAX_ATTACHMENTS));
            return;
          }

          const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
          const verdict = classifyFile(file.name, file.type, head);

          // A pasted screenshot always arrives as "image.png"; name it before
          // anything reports on it, collisions included.
          const name =
            source === "paste" && verdict.ok && verdict.kind === "image" && isGenericPastedName(file.name)
              ? pastedImageName(
                  itemsRef.current.map((item) => item.name),
                  file.type,
                )
              : file.name;

          if (!verdict.ok) {
            raise(copy.refusalNotice(verdict, name));
            continue;
          }

          // Everything below runs before a chip exists: a file that cannot be
          // sent never gets a progress bar.
          if (verdict.kind === "image") {
            if (file.size > MAX_SOURCE_IMAGE_BYTES) {
              raise(copy.tooLarge(name, formatBytes(MAX_SOURCE_IMAGE_BYTES), "image"));
              continue;
            }
            // Decoded once, here: the dimensions are what the token gate needs
            // and the bitmap is handed straight to the downscale below.
            let probe: SourceImage;
            try {
              probe = await decodeImage(file);
            } catch {
              raise(copy.undecodableImage(name));
              continue;
            }
            // The cost that matters is the one after the downscale, so a 24MP
            // photo is judged on the 2048px image the model will really see.
            const target = fitWithin(probe.width, probe.height, downscaleEdge(active));
            const tokens = estimateImageTokens(target.width, target.height);
            if (tokens > active.maxFileTokens) {
              probe.bitmap.close();
              raise(copy.fileOverBudget(name, tokens, active.maxFileTokens));
              continue;
            }
            const localId = createId();
            update((previous) => [
              ...previous,
              {
                localId,
                name,
                kind: "image",
                status: "preparing",
                bytes: file.size,
                estimatedTokens: tokens,
                mime: file.type,
                width: target.width,
                height: target.height,
                blob: file,
              },
            ]);
            void prepareAndUpload(localId, file, name, probe, conversation);
            continue;
          }

          const decoded = decodeText(new Uint8Array(await file.arrayBuffer()));
          if (!decoded) {
            raise(copy.undecodableText(name));
            continue;
          }
          const tokens = estimateTextTokens(decoded.text);
          if (tokens > active.maxFileTokens) {
            raise(copy.fileOverBudget(name, tokens, active.maxFileTokens));
            continue;
          }
          const bytes = utf8ByteLength(decoded.text);
          if (bytes > active.maxFileBytes) {
            raise(copy.tooLarge(name, formatBytes(active.maxFileBytes), "text"));
            continue;
          }
          if (conversationRef.current !== conversation) return;

          const localId = createId();
          update((previous) => [
            ...previous,
            {
              localId,
              name,
              kind: "text",
              status: "preparing",
              bytes,
              estimatedTokens: tokens,
              mime: TEXT_UPLOAD_MIME,
              text: decoded.text,
              // Uploaded as UTF-8 whatever the file's own encoding was, so the
              // server never has to know about CP949.
              blob: new Blob([decoded.text], { type: TEXT_UPLOAD_MIME }),
            },
          ]);
          void upload(localId, conversation);
        }
      })();
    },
    [prepareAndUpload, raise, update, upload],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      controllers.current.get(localId)?.abort();
      controllers.current.delete(localId);
      if (item?.serverId) {
        void api.deleteAttachment(conversationRef.current, item.serverId).catch(() => {
          // The conversation's own cleanup will collect it; nothing to say.
        });
      }
      discard(localId);
    },
    [discard],
  );

  const retry = useCallback(
    (localId: string) => {
      void upload(localId, conversationRef.current);
    },
    [upload],
  );

  const clear = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    for (const item of itemsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    itemsRef.current = [];
    setItems([]);
  }, []);

  const readyIds = useCallback(
    () =>
      itemsRef.current
        .filter((item) => item.status === "ready" && item.serverId)
        .map((item) => item.serverId as string),
    [],
  );

  const totalTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const overBudgetSet = overBudgetIds(items, limits.maxMessageTokens);

  return {
    items,
    notice,
    totalTokens,
    hasPending: items.some((item) => item.status === "preparing" || item.status === "uploading"),
    hasFailed: items.some((item) => item.status === "failed"),
    overBudget: overBudgetSet.size > 0,
    overBudgetIds: overBudgetSet,
    limits,
    addFiles,
    remove,
    retry,
    clear,
    readyIds,
    dismissNotice,
    reportSubmitBlocked,
  };
}

function noticeForUploadError(error: unknown, name: string, limits: AttachmentLimits): NoticeSpec {
  if (!(error instanceof AttachmentError) || error.code === null) return copy.uploadFailed(name);
  switch (error.code) {
    case "too_large":
      return copy.tooLarge(name, formatBytes(limits.maxFileBytes));
    case "unsupported_type":
    case "unsupported_document":
      return copy.unsupportedType(name);
    case "undecodable_text":
      return copy.undecodableText(name);
    case "too_many":
      return copy.tooMany(MAX_ATTACHMENTS);
    case "quota":
    case "rate_limited":
      return copy.uploadFailed(name);
    default:
      return copy.uploadFailed(name);
  }
}
