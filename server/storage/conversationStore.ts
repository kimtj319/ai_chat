import fs from "node:fs/promises";
import crypto from "node:crypto";
import { readJsonFile, readdirOrEmpty, unlinkIfPresent, writeJsonFileAtomic } from "./atomic.js";
import { conversationsDir, conversationFile, isValidId, ownersRoot } from "./paths.js";
import { withLock } from "./mutex.js";
import { deleteConversationAttachments } from "./attachmentStore.js";
import { DEFAULT_SETTINGS } from "../types.js";
import { listTools } from "../tools/index.js";
import type { Conversation, ConversationSettings, ConversationSummary, HistorySummary } from "../types.js";

/** 새로 만든 대화의 제목. 첫 메시지가 오면 그 내용으로 바뀐다. */
export const DEFAULT_CONVERSATION_TITLE = "새 대화";

/**
 * 아직 이름이 붙지 않은 대화인가. 예전 기본 제목 "New Chat" 으로 저장된 파일도
 * 남아 있으므로 둘 다 기본 제목으로 친다.
 */
export function isDefaultConversationTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length === 0 || trimmed === DEFAULT_CONVERSATION_TITLE || trimmed === "New Chat";
}

function lockKey(ownerId: string, conversationId: string): string {
  return `conv:${ownerId}:${conversationId}`;
}

/**
 * 목록에 쓰는 요약을 파일의 (수정 시각, 크기)로 기억한다. 목록은 사이드바가 열릴 때와
 * 답이 끝날 때마다 불리는데, 매번 모든 대화를 끝까지 읽고 해석했다 — 도구 결과가 실린
 * 대화는 파일 하나가 수 MB 라 대화가 쌓일수록 목록이 느려졌다. 쓰기는 늘 임시 파일 +
 * rename 이라(atomic.ts) 바뀐 파일은 수정 시각이 바뀌고, 그 파일만 다시 읽는다.
 */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: ConversationSummary | null }>();

async function summaryOf(file: string): Promise<ConversationSummary | null> {
  const stat = await fs.stat(file);
  const hit = summaryCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.summary;
  const conv = await readJsonFile<Conversation>(file);
  // A conversation the user opened but never typed in is not history —
  // it exists only so the composer has something to write to. Hiding it
  // here (rather than deleting it) keeps the open tab working while
  // keeping the sidebar clean; it becomes visible on its first message.
  const summary: ConversationSummary | null =
    conv && conv.messages.length > 0
      ? {
          id: conv.id,
          title: conv.title,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messageCount: conv.messages.length,
          // So the sidebar can mark an embedding conversation without loading it.
          ...(conv.kind ? { kind: conv.kind } : {}),
        }
      : null;
  summaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

export async function listConversations(ownerId: string): Promise<ConversationSummary[]> {
  const dir = conversationsDir(ownerId);
  const entries = await readdirOrEmpty(dir);

  const summaries: ConversationSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!isValidId(id)) continue;
    try {
      const summary = await summaryOf(`${dir}/${entry}`);
      if (summary) summaries.push({ ...summary });
    } catch (err) {
      // 읽는 사이 지워진 파일(ENOENT)은 목록에서 빠질 뿐이다.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.warn(`[conversationStore] skipping corrupt conversation file "${entry}" (owner ${ownerId}):`, err);
    }
  }

  // 지워진 대화의 요약은 들고 있지 않는다.
  const present = new Set(entries.map((entry) => `${dir}/${entry}`));
  for (const file of summaryCache.keys()) {
    if (file.startsWith(`${dir}/`) && !present.has(file)) summaryCache.delete(file);
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
    title: input.title?.trim() || DEFAULT_CONVERSATION_TITLE,
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
    if (!(await unlinkIfPresent(conversationFile(ownerId, conversationId)))) return false;
    // Inside the same lock: the conversation is gone, so nothing can ever
    // reference these bytes again, and the sweep would only find them later.
    await deleteConversationAttachments(ownerId, conversationId);
    return true;
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
