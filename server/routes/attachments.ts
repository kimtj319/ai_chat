import crypto from "node:crypto";
import fs from "node:fs/promises";
import express, { Router, type ErrorRequestHandler } from "express";
import { config } from "../config.js";
import { isValidId } from "../storage/paths.js";
import { getConversation } from "../storage/conversationStore.js";
import {
  conversationAttachmentUsage,
  deleteAttachment,
  getAttachmentMeta,
  readAttachmentBytes,
  saveAttachment,
  ownerAttachmentUsage,
} from "../storage/attachmentStore.js";
import { withLock } from "../storage/mutex.js";
import { sniffAttachment } from "../attachments/sniff.js";
import { attachmentBudget, describeCost, textPromptTokens } from "../attachments/budget.js";
import { resolveModel } from "../vllm/client.js";
import type { AttachmentErrorCode, MessageAttachment } from "../types.js";

export const attachmentsRouter = Router();

/**
 * The filename arrives in the query string, percent-encoded — never in a header
 * and never as a path component. Headers are latin-1, so a Korean filename
 * reaches the server as mojibake there; and the stored path is built from
 * server-generated UUIDs only, so whatever this returns is display metadata and
 * nothing more.
 */
const FALLBACK_NAME = "첨부파일";
const MAX_NAME_CHARS = 200;

function safeName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return FALLBACK_NAME;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw; // not actually percent-encoded; take it as it came
  }
  // Keep only the last segment, so "../../etc/passwd" is displayed as
  // "passwd" rather than as something that looks like a path.
  const segment = decoded.split(/[/\\]/).pop() ?? "";
  // Control characters would break the JSON response and the UI label.
  const cleaned = segment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, MAX_NAME_CHARS) || FALLBACK_NAME;
}

function fail(res: express.Response, status: number, code: AttachmentErrorCode, error: string) {
  res.status(status).json({ error, code });
}

/**
 * In-memory token bucket, 30 uploads a minute per account by default. In
 * memory on purpose: it protects this process's disk and CPU, and a restart
 * losing the counters is not a security property anyone relies on.
 */
const RATE_WINDOW_MS = 60_000;
const buckets = new Map<string, { tokens: number; last: number }>();

function takeUploadToken(ownerId: string): boolean {
  const capacity = config.attachmentUploadsPerMinute;
  const now = Date.now();
  const bucket = buckets.get(ownerId) ?? { tokens: capacity, last: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / RATE_WINDOW_MS) * capacity);
  bucket.last = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  buckets.set(ownerId, bucket);
  // Accounts only grow, so a full bucket that has not been touched in five
  // windows is dropped rather than kept forever.
  if (buckets.size > 1000) {
    for (const [key, value] of buckets) {
      if (now - value.last > 5 * RATE_WINDOW_MS) buckets.delete(key);
    }
  }
  return allowed;
}

/** Free space on DATA_DIR, or null where statfs is unavailable (then the check is skipped). */
async function freeDiskBytes(): Promise<number | null> {
  try {
    const stat = await fs.statfs(config.dataDir);
    return Number(stat.bsize) * Number(stat.bavail);
  } catch {
    return null;
  }
}

attachmentsRouter.post(
  "/conversations/:id/attachments",
  // Scoped to this one route: a global raw parser would swallow every JSON body
  // in the app. `type: () => true` because the declared Content-Type is only a
  // hint here — the bytes are what decide the kind.
  express.raw({ type: () => true, limit: Math.max(config.attachmentMaxImageBytes, config.attachmentMaxTextBytes) }),
  async (req, res, next) => {
    try {
      const conversationId = req.params.id;
      if (!isValidId(conversationId)) return res.status(404).json({ error: "Not found" });
      const conversation = await getConversation(req.ownerId, conversationId);
      if (!conversation) return res.status(404).json({ error: "Not found" });

      if (!takeUploadToken(req.ownerId)) {
        return fail(res, 429, "rate_limited", `업로드가 너무 잦습니다. 1분에 ${config.attachmentUploadsPerMinute}개까지 올릴 수 있습니다.`);
      }

      const free = await freeDiskBytes();
      if (free !== null && free < config.attachmentMinFreeDiskBytes) {
        return fail(res, 507, "quota", "서버 저장 공간이 부족하여 첨부를 받을 수 없습니다. 관리자에게 알려 주세요.");
      }

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return fail(res, 400, "unsupported_type", "빈 요청입니다. 파일 본문을 그대로 보내 주세요.");
      }

      const sniffed = sniffAttachment(body, {
        maxImageBytes: config.attachmentMaxImageBytes,
        maxTextBytes: config.attachmentMaxTextBytes,
      });
      if (!sniffed.ok) return fail(res, sniffed.status, sniffed.code, sniffed.message);

      const name = safeName(req.query.name);
      const now = new Date().toISOString();
      const meta: MessageAttachment =
        sniffed.kind === "image"
          ? {
              id: crypto.randomUUID(),
              kind: "image",
              name,
              mime: sniffed.mime,
              bytes: body.length,
              ...(sniffed.width !== undefined ? { width: sniffed.width, height: sniffed.height } : {}),
              estimatedTokens: sniffed.estimatedTokens,
              createdAt: now,
            }
          : (() => {
              const chars = sniffed.text.length;
              const inlined = Buffer.byteLength(sniffed.text, "utf8") <= config.attachmentInlineTextBytes;
              return {
                id: crypto.randomUUID(),
                kind: "text" as const,
                name,
                mime: sniffed.mime,
                bytes: body.length,
                chars,
                inlined,
                estimatedTokens: textPromptTokens(chars, inlined),
                createdAt: now,
              };
            })();

      // The token ceiling comes from the window THIS conversation's model
      // reports, so a conversation on a smaller model gets a smaller ceiling.
      const { maxModelLen } = await resolveModel(conversation.model).catch(() => ({ maxModelLen: null }));
      const budget = attachmentBudget(maxModelLen);
      const cost = meta.estimatedTokens ?? 0;
      if (cost > budget.singleFileTokens) {
        return fail(
          res,
          413,
          "too_large",
          `${describeCost(meta.name, cost)}로, 파일 하나가 쓸 수 있는 한도 ${budget.singleFileTokens.toLocaleString("en-US")}토큰을 넘습니다` +
            `${budget.fallback ? " (모델이 컨텍스트 길이를 알려주지 않아 기본값을 적용했습니다)" : ""}. 더 작은 파일로 나눠서 올려 주세요.`,
        );
      }

      // Serialised per conversation so two parallel uploads cannot both pass
      // the same quota check and land over it.
      const stored = await withLock<{ error?: string }>(`attach:${req.ownerId}:${conversationId}`, async () => {
        const conversationUsage = await conversationAttachmentUsage(req.ownerId, conversationId);
        if (conversationUsage.count >= config.attachmentMaxPerConversation) {
          return { error: `이 대화에는 첨부를 ${config.attachmentMaxPerConversation}개까지 보관할 수 있습니다.` };
        }
        if (conversationUsage.bytes + body.length > config.attachmentMaxConversationBytes) {
          return { error: `이 대화의 첨부 용량 한도(${mb(config.attachmentMaxConversationBytes)}MB)를 넘습니다.` };
        }
        const ownerUsage = await ownerAttachmentUsage(req.ownerId);
        if (ownerUsage.bytes + body.length > config.attachmentMaxSessionBytes) {
          return { error: `계정 전체 첨부 용량 한도(${mb(config.attachmentMaxSessionBytes)}MB)를 넘습니다. 지난 대화의 첨부를 정리해 주세요.` };
        }
        await saveAttachment(req.ownerId, conversationId, meta, body);
        return {};
      });
      if (stored.error) return fail(res, 413, "quota", stored.error);

      console.log(
        `[attachments] stored ${meta.kind} ${meta.id} (${meta.bytes} bytes, ${cost} tokens) for ${conversationId}`,
      );
      res.status(201).json(meta);
    } catch (err) {
      next(err);
    }
  },
);

attachmentsRouter.get("/conversations/:id/attachments/:aid", async (req, res, next) => {
  try {
    const { id, aid } = req.params;
    if (!isValidId(id) || !isValidId(aid)) return res.status(404).json({ error: "Not found" });
    const meta = await getAttachmentMeta(req.ownerId, id, aid);
    const bytes = meta ? await readAttachmentBytes(req.ownerId, id, aid) : null;
    if (!meta || !bytes) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Content-Length", String(bytes.length));
    // These bytes came from a user and are served from the app's own origin:
    // nosniff keeps the browser from re-deciding what they are, and the
    // filename is sent RFC 5987-encoded so a Korean name survives.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(bytes);
  } catch (err) {
    next(err);
  }
});

attachmentsRouter.delete("/conversations/:id/attachments/:aid", async (req, res, next) => {
  try {
    const { id, aid } = req.params;
    if (!isValidId(id) || !isValidId(aid)) return res.status(404).json({ error: "Not found" });
    const deleted = await deleteAttachment(req.ownerId, id, aid);
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * express.raw rejects an oversized body itself, before the handler runs, and
 * the app-wide handler would answer it without a `code`. Same refusal, same
 * shape as every other attachment error.
 */
const attachmentErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if ((err as { type?: string })?.type === "entity.too.large") {
    return fail(
      res,
      413,
      "too_large",
      `파일이 너무 큽니다. 이미지는 최대 ${mb(config.attachmentMaxImageBytes)}MB, 텍스트 파일은 최대 ${mb(config.attachmentMaxTextBytes)}MB 입니다.`,
    );
  }
  next(err);
};
attachmentsRouter.use(attachmentErrorHandler);

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
