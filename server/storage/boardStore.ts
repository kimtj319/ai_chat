/**
 * 문의 게시판의 글과 답변. 파일 하나에 글 하나, 답변은 그 안에 함께.
 *
 * 소유자별로 나누지 않는다: 게시판은 모두가 보는 곳이고, 누가 썼는지는 파일이
 * 어디에 놓였는지가 아니라 레코드의 authorId 가 말한다. 문서 저장소와 정반대
 * 인데 그게 맞다 — 문서는 기본이 '내 것' 이고 공개가 예외, 글은 기본이
 * '모두의 것' 이다.
 *
 * 답변을 따로 파일로 두지 않는 이유도 같은 결이다. 글과 답변은 언제나 함께
 * 읽히고 함께 지워진다. 나누면 둘을 맞춰 두는 일만 늘어난다.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readJsonFile, writeJsonFileAtomic } from "./atomic.js";
import { boardPostFile, boardPostsDir, isValidId } from "./paths.js";
import { withLock } from "./mutex.js";
import type { BoardPost, BoardPostStatus, BoardReply } from "../types.js";

/** 한 글을 고치는 일은 겹치지 않게 — 답변 두 개가 동시에 달려도 하나가 사라지지 않는다. */
const lockFor = (postId: string) => `board:${postId}`;

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 20_000;
export const MAX_TAGS = 8;
export const MAX_TAG_CHARS = 24;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

/** 제어문자를 걷고 앞뒤를 다듬는다. 길이를 넘으면 자른다 — 거절보다 낫다. */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const text = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 태그를 다듬는다. 사용자가 자유롭게 적으므로 여기가 유일한 관문이다.
 *
 * 소문자로 모으는 이유: "검색" 과 "검색 " 과 "Search" 와 "search" 가 네 개의
 * 다른 태그가 되면, 태그로 거르는 일이 성립하지 않는다. 공백은 하이픈으로
 * 바꿔 한 낱말로 만든다.
 */
export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const tag = item
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/^[#-]+|[-]+$/g, "");
    if (!tag) continue;
    seen.add(tag.length > MAX_TAG_CHARS ? tag.slice(0, MAX_TAG_CHARS) : tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

/** 새 글. 제목이 비면 만들지 않는다 — 목록에서 가리킬 것이 없는 글이 된다. */
export async function createPost(input: {
  authorId: string;
  title: unknown;
  body: unknown;
  tags: unknown;
}): Promise<BoardPost | null> {
  const title = cleanText(input.title, MAX_TITLE_CHARS);
  if (!title) return null;
  const now = new Date().toISOString();
  const post: BoardPost = {
    id: newId("post"),
    title,
    body: cleanText(input.body, MAX_BODY_CHARS),
    tags: normalizeTags(input.tags),
    status: "open",
    authorId: input.authorId,
    replies: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFileAtomic(boardPostFile(post.id), post);
  return post;
}

export async function getPost(postId: string): Promise<BoardPost | null> {
  if (!isValidId(postId)) return null;
  try {
    return await readJsonFile<BoardPost>(boardPostFile(postId));
  } catch (err) {
    // 깨진 파일 하나가 게시판 전체를 못 열게 만들지는 않는다.
    console.warn(`[board] 글을 읽지 못했습니다 (${postId}):`, err);
    return null;
  }
}

/** 전부, 새것이 먼저. 게시판 규모에서는 한 번에 읽어도 된다. */
export async function listPosts(): Promise<BoardPost[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(boardPostsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const posts: BoardPost[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const post = await getPost(entry.slice(0, -".json".length));
    if (post) posts.push(post);
  }
  posts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return posts;
}

/** 답변을 단다. 답변이 달렸다고 글이 다시 열리지는 않는다 — 상태는 사람이 정한다. */
export async function addReply(postId: string, authorId: string, body: unknown): Promise<BoardPost | null> {
  const text = cleanText(body, MAX_BODY_CHARS);
  if (!text) return null;
  return withLock(lockFor(postId), async () => {
    const post = await getPost(postId);
    if (!post) return null;
    const reply: BoardReply = {
      id: newId("reply"),
      authorId,
      body: text,
      createdAt: new Date().toISOString(),
    };
    const updated: BoardPost = {
      ...post,
      replies: [...post.replies, reply],
      updatedAt: reply.createdAt,
    };
    await writeJsonFileAtomic(boardPostFile(postId), updated);
    return updated;
  });
}

/** 열고 닫는다. 누가 할 수 있는지는 라우트가 정한다 — 여기는 기록만 한다. */
export async function setStatus(postId: string, status: BoardPostStatus, by: string): Promise<BoardPost | null> {
  return withLock(lockFor(postId), async () => {
    const post = await getPost(postId);
    if (!post) return null;
    const now = new Date().toISOString();
    const updated: BoardPost = { ...post, status, updatedAt: now };
    if (status === "closed") {
      updated.closedBy = by;
      updated.closedAt = now;
    } else {
      // 다시 열면 닫은 기록은 지운다. 남겨 두면 "닫힌 적 있는 열린 글" 이
      // 되어 화면이 무엇을 보여 줘야 할지 모르게 된다.
      delete updated.closedBy;
      delete updated.closedAt;
    }
    await writeJsonFileAtomic(boardPostFile(postId), updated);
    return updated;
  });
}

export async function deletePost(postId: string): Promise<boolean> {
  if (!isValidId(postId)) return false;
  return withLock(lockFor(postId), async () => {
    try {
      await fs.unlink(boardPostFile(postId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}
