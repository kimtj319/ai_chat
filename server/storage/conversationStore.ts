import fs from "node:fs/promises";
import crypto from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { conversationsDir, conversationFile, isValidId, ownersRoot } from "./paths.js";
import { withLock } from "./mutex.js";
import { deleteConversationAttachments } from "./attachmentStore.js";
import { DEFAULT_SETTINGS } from "../types.js";
import { listTools } from "../tools/index.js";
import type { Conversation, ConversationSettings, ConversationSummary, HistorySummary } from "../types.js";

function lockKey(ownerId: string, conversationId: string): string {
  return `conv:${ownerId}:${conversationId}`;
}

export async function listConversations(ownerId: string): Promise<ConversationSummary[]> {
  const dir = conversationsDir(ownerId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const summaries: ConversationSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const id = entry.slice(0, -".json".length);
    if (!isValidId(id)) continue;
    try {
      const conv = await readJsonFile<Conversation>(`${dir}/${entry}`);
      if (!conv) continue;
      // A conversation the user opened but never typed in is not history —
      // it exists only so the composer has something to write to. Hiding it
      // here (rather than deleting it) keeps the open tab working while
      // keeping the sidebar clean; it becomes visible on its first message.
      if (conv.messages.length === 0) continue;
      summaries.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
        // So the sidebar can mark an embedding conversation without loading it.
        ...(conv.kind ? { kind: conv.kind } : {}),
      });
    } catch (err) {
      console.warn(`[conversationStore] skipping corrupt conversation file "${entry}" (owner ${ownerId}):`, err);
    }
  }

  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return summaries;
}

export async function getConversation(ownerId: string, conversationId: string): Promise<Conversation | null> {
  if (!isValidId(conversationId)) return null;
  try {
    return await readJsonFile<Conversation>(conversationFile(ownerId, conversationId));
  } catch (err) {
    console.warn(`[conversationStore] corrupt conversation file for ${ownerId}/${conversationId}:`, err);
    return null;
  }
}

export async function createConversation(
  ownerId: string,
  input: { title?: string; systemPrompt?: string; model?: string },
): Promise<Conversation> {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    title: input.title?.trim() || "New Chat",
    systemPrompt: input.systemPrompt ?? "",
    model: input.model ?? "",
    settings: { ...DEFAULT_SETTINGS },
    // Every registered tool is on by default so the model can reach for one
    // without the user having to enable it first. Per-conversation toggles in
    // the UI can still turn individual tools off.
    enabledTools: listTools().map((t) => t.name),
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFileAtomic(conversationFile(ownerId, conversation.id), conversation);
  return conversation;
}

export async function updateConversation(
  ownerId: string,
  conversationId: string,
  patch: {
    title?: string;
    systemPrompt?: string;
    model?: string;
    settings?: Partial<ConversationSettings>;
    enabledTools?: string[];
  },
): Promise<Conversation | null> {
  if (!isValidId(conversationId)) return null;
  return withLock(lockKey(ownerId, conversationId), async () => {
    const existing = await getConversation(ownerId, conversationId);
    if (!existing) return null;
    const updated: Conversation = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.settings !== undefined ? { settings: { ...existing.settings, ...patch.settings } } : {}),
      ...(patch.enabledTools !== undefined ? { enabledTools: patch.enabledTools } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(conversationFile(ownerId, conversationId), updated);
    return updated;
  });
}

/**
 * Remove conversations that were never used.
 *
 * Opening a new chat writes a record before a single word is typed, and if the
 * user never sends anything nothing ever removes it: one day of ordinary use
 * left 91 empty files on this deployment against 6 real conversations, 83 of
 * them without even a model chosen. They are invisible — listConversations
 * skips them — so they accumulate unnoticed.
 *
 * Only ones older than the grace period go: a record created seconds ago
 * belongs to a chat window that is open right now and about to be used.
 */
const EMPTY_CONVERSATION_GRACE_MS = 6 * 60 * 60 * 1000;

export async function sweepEmptyConversations(): Promise<{ removed: number; owners: number }> {
  let removed = 0;
  let owners = 0;
  let ownerIds: string[];
  try {
    ownerIds = await fs.readdir(ownersRoot());
  } catch {
    return { removed: 0, owners: 0 };
  }
  const cutoff = Date.now() - EMPTY_CONVERSATION_GRACE_MS;
  for (const ownerId of ownerIds) {
    if (!isValidId(ownerId)) continue;
    let files: string[];
    try {
      files = await fs.readdir(conversationsDir(ownerId));
    } catch {
      continue;
    }
    owners++;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      const conversation = await getConversation(ownerId, id);
      if (!conversation || conversation.messages.length > 0) continue;
      if (Date.parse(conversation.updatedAt ?? conversation.createdAt ?? "") > cutoff) continue;
      if (await deleteConversation(ownerId, id)) removed++;
    }
  }
  return { removed, owners };
}

export async function deleteConversation(ownerId: string, conversationId: string): Promise<boolean> {
  if (!isValidId(conversationId)) return false;
  return withLock(lockKey(ownerId, conversationId), async () => {
    try {
      await fs.unlink(conversationFile(ownerId, conversationId));
      // Inside the same lock: the conversation is gone, so nothing can ever
      // reference these bytes again, and the sweep would only find them later.
      await deleteConversationAttachments(ownerId, conversationId);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

/**
 * Load a conversation under its per-conversation lock, let `mutator` change
 * it in place (or return a replacement), bump `updatedAt`, and persist
 * atomically. Returns null if the conversation doesn't exist (e.g. wrong
 * owner, or deleted concurrently).
 */
export async function mutateConversation(
  ownerId: string,
  conversationId: string,
  mutator: (conv: Conversation) => Conversation | void,
): Promise<Conversation | null> {
  if (!isValidId(conversationId)) return null;
  return withLock(lockKey(ownerId, conversationId), async () => {
    const existing = await getConversation(ownerId, conversationId);
    if (!existing) return null;
    const result = mutator(existing) ?? existing;
    result.updatedAt = new Date().toISOString();
    await writeJsonFileAtomic(conversationFile(ownerId, conversationId), result);
    return result;
  });
}

/**
 * Store the conversation's history summary (chat/historySummary.ts).
 *
 * Written through the same lock and the same atomic write as every other field,
 * so a turn that summarises cannot lose the assistant message the route appends
 * a moment later. The field is optional in the stored JSON: a file written
 * before summaries existed loads unchanged, and one written with a summary is
 * still read by a server that does not know about it.
 */
export async function saveHistorySummary(
  ownerId: string,
  conversationId: string,
  summary: HistorySummary,
): Promise<void> {
  await mutateConversation(ownerId, conversationId, (conv) => {
    conv.historySummary = summary;
  });
}
