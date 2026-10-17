/**
 * 공지사항: 관리자가 쓰고 모두가 읽는다. 파일 하나에 공지 하나.
 *
 * "새 공지" 표시는 계정마다 마지막으로 본 때(seenAt) 하나로 정한다 — 그보다 뒤에 올라온
 * 공지가 있으면 새것이다. 공지마다 읽음을 따로 적지 않는 이유는, 사람이 읽는 단위가
 * 공지 하나가 아니라 "공지 창을 열어 본 것" 이기 때문이다.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, unlinkIfPresent, writeJsonFileAtomic } from "./atomic.js";
import { isValidId, noticeFile, noticesDir, noticesSeenFile } from "./paths.js";
import { withLock } from "./mutex.js";

export const MAX_NOTICE_TITLE_CHARS = 120;
export const MAX_NOTICE_BODY_CHARS = 10_000;

export interface Notice {
  id: string;
  title: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

const lockFor = (noticeId: string) => `notice:${noticeId}`;

/** 제어문자를 걷고 앞뒤를 다듬는다. 길이를 넘으면 자른다. */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const text = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** 새 공지. 제목이 비면 만들지 않는다. */
export async function createNotice(input: { authorId: string; title: unknown; body: unknown }): Promise<Notice | null> {
  const title = cleanText(input.title, MAX_NOTICE_TITLE_CHARS);
  if (!title) return null;
  const now = new Date().toISOString();
  const notice: Notice = {
    id: `notice_${crypto.randomBytes(6).toString("hex")}`,
    title,
    body: cleanText(input.body, MAX_NOTICE_BODY_CHARS),
    authorId: input.authorId,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFileAtomic(noticeFile(notice.id), notice);
  return notice;
}

export async function getNotice(noticeId: string): Promise<Notice | null> {
  if (!isValidId(noticeId)) return null;
  return readJsonFile<Notice>(noticeFile(noticeId));
}

/** 새것부터. 고쳐도 순서는 처음 올린 때를 따른다 — 고친 공지가 맨 위로 튀어 오르면 안 된다. */
export async function listNotices(): Promise<Notice[]> {
  let names: string[];
  try {
    names = await fs.readdir(noticesDir());
  } catch {
    return [];
  }
  const notices: Notice[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const notice = await readJsonFile<Notice>(path.join(noticesDir(), name)).catch(() => null);
    if (notice?.id && notice.title) notices.push(notice);
  }
  return notices.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 제목·본문을 고친다. 제목을 비우려 하면 거절(null). */
export async function updateNotice(noticeId: string, patch: { title?: unknown; body?: unknown }): Promise<Notice | null> {
  return withLock(lockFor(noticeId), async () => {
    const current = await getNotice(noticeId);
    if (!current) return null;
    const title = patch.title === undefined ? current.title : cleanText(patch.title, MAX_NOTICE_TITLE_CHARS);
    if (!title) return null;
    const next: Notice = {
      ...current,
      title,
      body: patch.body === undefined ? current.body : cleanText(patch.body, MAX_NOTICE_BODY_CHARS),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(noticeFile(noticeId), next);
    return next;
  });
}

export async function deleteNotice(noticeId: string): Promise<boolean> {
  if (!isValidId(noticeId)) return false;
  // 없는 공지만 false 다. 다른 오류(권한 등)는 "없는 공지" 로 숨기지 않고 던진다.
  return withLock(lockFor(noticeId), async () => unlinkIfPresent(noticeFile(noticeId)));
}

/** 이 계정이 공지를 마지막으로 본 때. 한 번도 안 봤으면 null. */
export async function noticesSeenAt(ownerId: string): Promise<string | null> {
  const record = await readJsonFile<{ seenAt?: string }>(noticesSeenFile(ownerId)).catch(() => null);
  return typeof record?.seenAt === "string" ? record.seenAt : null;
}

export async function markNoticesSeen(ownerId: string, at = new Date().toISOString()): Promise<string> {
  await writeJsonFileAtomic(noticesSeenFile(ownerId), { seenAt: at });
  return at;
}

/** seenAt 보다 뒤에 올라온 공지 수. 한 번도 안 봤으면 전부. */
export function unreadCount(notices: Notice[], seenAt: string | null): number {
  if (!seenAt) return notices.length;
  return notices.filter((n) => n.createdAt > seenAt).length;
}
