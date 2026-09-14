import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonFileAtomic } from "./atomic.js";
import {
  attachmentBinFile,
  attachmentMetaFile,
  attachmentsDir,
  conversationFile,
  isValidId,
  ownerAttachmentsDir,
  ownerDir,
} from "./paths.js";
import { config } from "../config.js";
import type { Conversation, MessageAttachment } from "../types.js";

/**
 * Attachment bytes on disk, at
 *   {DATA_DIR}/owners/{ownerId}/attachments/{conversationId}/{attachmentId}.bin
 * with a .json sidecar holding the metadata. The owner is the account id, so a
 * user's files follow the account rather than the browser session.
 *
 * Both id segments are server-generated UUIDs that the caller has validated
 * with isValidId(); the user-supplied filename is metadata only. The store
 * lives under DATA_DIR, which tools/fsRoot.ts already refuses to let
 * read_text_file reach, so attachments inherit that protection — read_attachment
 * reads these files directly instead of going through the filesystem tools.
 */

/**
 * How long an attachment may sit unreferenced before the sweep removes it.
 * An upload happens before the message that carries it is sent, so there is
 * always a window where it belongs to nothing; 30 minutes is long enough to
 * write a message around it and short enough that an abandoned composer does
 * not leak the bytes forever.
 */
const ORPHAN_TTL_MS = 30 * 60 * 1000;

export async function saveAttachment(
  ownerId: string,
  conversationId: string,
  meta: MessageAttachment,
  bytes: Buffer,
): Promise<void> {
  // Bytes first: a sidecar with no payload would look like a usable attachment.
  await writeFileAtomic(attachmentBinFile(ownerId, conversationId, meta.id), bytes);
  await writeJsonFileAtomic(attachmentMetaFile(ownerId, conversationId, meta.id), meta);
}

export async function getAttachmentMeta(
  ownerId: string,
  conversationId: string,
  attachmentId: string,
): Promise<MessageAttachment | null> {
  if (!isValidId(conversationId) || !isValidId(attachmentId)) return null;
  try {
    return await readJsonFile<MessageAttachment>(attachmentMetaFile(ownerId, conversationId, attachmentId));
  } catch (err) {
    console.warn(`[attachmentStore] corrupt metadata for ${ownerId}/${conversationId}/${attachmentId}:`, err);
    return null;
  }
}

export async function readAttachmentBytes(
  ownerId: string,
  conversationId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  if (!isValidId(conversationId) || !isValidId(attachmentId)) return null;
  try {
    return await fs.readFile(attachmentBinFile(ownerId, conversationId, attachmentId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteAttachment(
  ownerId: string,
  conversationId: string,
  attachmentId: string,
): Promise<boolean> {
  if (!isValidId(conversationId) || !isValidId(attachmentId)) return false;
  const bin = attachmentBinFile(ownerId, conversationId, attachmentId);
  const meta = attachmentMetaFile(ownerId, conversationId, attachmentId);
  const removed = await unlinkIfPresent(bin);
  await unlinkIfPresent(meta);
  return removed;
}

/** Every attachment currently stored for one conversation, oldest first. */
export async function listAttachments(ownerId: string, conversationId: string): Promise<MessageAttachment[]> {
  const dir = attachmentsDir(ownerId, conversationId);
  const entries = await readdirOrEmpty(dir);
  const metas: MessageAttachment[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const id = entry.slice(0, -".json".length);
    if (!isValidId(id)) continue;
    const meta = await getAttachmentMeta(ownerId, conversationId, id);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return metas;
}

/** Bytes stored for one conversation, and for a whole account. Used for the quotas. */
export async function conversationAttachmentUsage(
  ownerId: string,
  conversationId: string,
): Promise<{ count: number; bytes: number }> {
  return usageOf(attachmentsDir(ownerId, conversationId));
}

export async function ownerAttachmentUsage(ownerId: string): Promise<{ count: number; bytes: number }> {
  const root = ownerAttachmentsDir(ownerId);
  const total = { count: 0, bytes: 0 };
  for (const conversationId of await readdirOrEmpty(root)) {
    const one = await usageOf(path.join(root, conversationId));
    total.count += one.count;
    total.bytes += one.bytes;
  }
  return total;
}

/** Called from deleteConversation, inside the conversation's own lock. */
export async function deleteConversationAttachments(ownerId: string, conversationId: string): Promise<void> {
  if (!isValidId(conversationId)) return;
  await fs.rm(attachmentsDir(ownerId, conversationId), { recursive: true, force: true });
}

/**
 * Remove attachments of one conversation that no message references and that
 * are older than ORPHAN_TTL_MS. Returns how many were removed.
 */
export async function sweepConversationAttachments(
  ownerId: string,
  conversationId: string,
  referenced: ReadonlySet<string>,
): Promise<number> {
  const dir = attachmentsDir(ownerId, conversationId);
  const entries = await readdirOrEmpty(dir);
  const cutoff = Date.now() - ORPHAN_TTL_MS;
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = entry.replace(/\.(bin|json)$/, "");
    if (entry !== id && isValidId(id)) ids.add(id);
  }

  let removed = 0;
  for (const id of ids) {
    if (referenced.has(id)) continue;
    const meta = await getAttachmentMeta(ownerId, conversationId, id);
    // mtime covers the half-written pair (bytes but no sidecar yet), where
    // there is no createdAt to read.
    const createdAt = meta ? Date.parse(meta.createdAt) : await mtimeOf(attachmentBinFile(ownerId, conversationId, id));
    if (Number.isFinite(createdAt) && createdAt > cutoff) continue;
    if (await deleteAttachment(ownerId, conversationId, id)) removed++;
  }
  return removed;
}

/**
 * Startup sweep over every account. A crashed or closed browser leaves uploads
 * behind that no message will ever reference, and nothing else would ever
 * delete them.
 *
 * Only {DATA_DIR}/owners is walked. The pre-accounts {DATA_DIR}/sessions
 * directories are deliberately left alone — they belong to no account, nothing
 * can reach them any more, and deleting someone's history to tidy up would be
 * the worse failure (README, "Storage").
 *
 * The conversation file is read directly rather than through conversationStore,
 * which imports this module to delete a conversation's attachments — going the
 * other way too would make the two a cycle for one readJsonFile call.
 */
export async function sweepAllAttachments(): Promise<{ removed: number; conversations: number }> {
  const ownersRoot = path.join(config.dataDir, "owners");
  let removed = 0;
  let conversations = 0;
  for (const ownerId of await readdirOrEmpty(ownersRoot)) {
    if (!isValidId(ownerId)) continue;
    // Defensive: only walk what is really a directory of ours.
    if (!(await exists(ownerDir(ownerId)))) continue;
    for (const conversationId of await readdirOrEmpty(ownerAttachmentsDir(ownerId))) {
      if (!isValidId(conversationId)) continue;
      conversations++;
      const conversation = await readJsonFile<Conversation>(conversationFile(ownerId, conversationId)).catch(() => null);
      if (!conversation) {
        // The conversation is gone (deleted before this feature existed, or a
        // failed delete): its attachments can never be referenced again.
        await deleteConversationAttachments(ownerId, conversationId);
        continue;
      }
      removed += await sweepConversationAttachments(ownerId, conversationId, referencedAttachmentIds(conversation));
    }
  }
  return { removed, conversations };
}

/** Every attachment id any message of this conversation still points at. */
export function referencedAttachmentIds(conversation: Conversation): Set<string> {
  const ids = new Set<string>();
  for (const message of conversation.messages) {
    for (const attachment of message.attachments ?? []) ids.add(attachment.id);
  }
  return ids;
}

async function usageOf(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const entry of await readdirOrEmpty(dir)) {
    if (!entry.endsWith(".bin")) continue;
    const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
    if (!stat?.isFile()) continue;
    count++;
    bytes += stat.size;
  }
  return { count, bytes };
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function unlinkIfPresent(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function mtimeOf(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat ? stat.mtimeMs : Number.NaN;
}

async function exists(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => null)) !== null;
}
