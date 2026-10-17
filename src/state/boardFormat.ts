/**
 * 문의 게시판이 글·답변을 GitLab 이슈처럼 보여 주는 데 쓰는 순수 함수들.
 * 화면 밖에서 검사할 수 있게 컴포넌트와 떼어 둔다.
 */
import type { BoardPostView } from "../api/types";

/** "방금", "5분 전", "3시간 전", "2일 전", 그보다 오래면 날짜. now 는 검사용. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return "방금";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}일 전`;
  return new Date(t).toLocaleDateString("ko-KR", { dateStyle: "medium" });
}

/** 마우스를 올리면 보이는 정확한 시각. */
export function exactTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ko-KR", { dateStyle: "long", timeStyle: "short" });
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h;
}

/** 라벨·아바타의 색(0~359). 같은 이름은 어디서나 같은 색 — GitLab 라벨처럼 색으로 알아본다. */
export function hueOf(text: string): number {
  return hash(text) % 360;
}

/** 아바타에 쓰는 한 글자. 이름이 없으면 아이디의 첫 글자. */
export function initialOf(name: string | null, id: string): string {
  const source = (name || id).trim();
  return source ? [...source][0]!.toUpperCase() : "?";
}

export type TimelineItem =
  | { kind: "reply"; at: string; reply: BoardPostView["replies"][number] }
  | { kind: "closed"; at: string; by: string };

/** 답변과 '닫음' 기록을 시간 순으로 한 줄에 — GitLab 활동 목록처럼. */
export function timelineOf(post: BoardPostView): TimelineItem[] {
  const items: TimelineItem[] = post.replies.map((reply) => ({ kind: "reply", at: reply.createdAt, reply }));
  if (post.status === "closed" && post.closedAt) {
    items.push({ kind: "closed", at: post.closedAt, by: post.closedBy ?? "" });
  }
  // 같은 시각이면 답변이 먼저 — "답변하고 닫기" 는 답을 단 다음 닫은 것이다.
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === "reply" ? -1 : 1));
}

/** 글쓴이와 답한 사람, 처음 나온 순서대로 한 번씩. */
export function participantsOf(post: BoardPostView): Array<{ id: string; name: string | null }> {
  const seen = new Map<string, string | null>([[post.authorId, post.authorName]]);
  for (const r of post.replies) if (!seen.has(r.authorId)) seen.set(r.authorId, r.authorName);
  return [...seen].map(([id, name]) => ({ id, name }));
}
