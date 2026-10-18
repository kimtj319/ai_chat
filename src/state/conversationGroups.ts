/**
 * 사이드바 대화 목록을 날짜로 묶고, 제목으로 거른다.
 *
 * 묶음은 '오늘' → '어제' → '지난 7일' → '지난 30일' → 'YYYY년 M월'(최근 달부터) 순서다.
 * 날짜는 마지막으로 바뀐 때(updatedAt)로 보고, 없거나 읽을 수 없으면 만든 때(createdAt).
 * 날짜 경계는 이 브라우저의 지역 자정이다 — "어제" 는 24시간 전이 아니라 달력의 어제다.
 * 묶음 안의 순서는 받은 순서 그대로 둔다(서버가 이미 최근 것부터 준다).
 *
 * 고정한 대화(pinned)는 날짜와 상관없이 맨 위 '고정됨' 한 묶음에만 둔다 — 같은 제목이
 * 아홉 개씩 쌓이는 목록에서 늘 돌아가는 대화를 찾아 내려가지 않게.
 */

export interface Dated {
  createdAt: string;
  updatedAt?: string;
  pinned?: boolean;
}

export interface ConversationGroup<T> {
  /** React key. 라벨과 같지만 바뀌지 않는 값으로 둔다. */
  key: string;
  label: string;
  items: T[];
}

const DAY_MS = 86_400_000;

function timeOf(item: Dated): number | null {
  for (const value of [item.updatedAt, item.createdAt]) {
    const t = value ? Date.parse(value) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 묶음의 자리(작을수록 위)와 이름. 달 묶음은 최근 달이 위로 오게 음수 연월을 쓴다. */
function bucketOf(t: number | null, today: number): { rank: number; key: string; label: string } {
  if (t === null) return { rank: Number.MAX_SAFE_INTEGER, key: "unknown", label: "날짜 없음" };
  // 서머타임이 있는 지역에서는 하루가 23·25시간일 수 있어 반올림한다.
  const days = Math.round((today - startOfDay(t)) / DAY_MS);
  if (days <= 0) return { rank: -4e6, key: "today", label: "오늘" };
  if (days === 1) return { rank: -3e6, key: "yesterday", label: "어제" };
  if (days <= 7) return { rank: -2e6, key: "7d", label: "지난 7일" };
  if (days <= 30) return { rank: -1e6, key: "30d", label: "지난 30일" };
  const d = new Date(t);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return { rank: -(year * 12 + month), key: `${year}-${month}`, label: `${year}년 ${month}월` };
}

export function groupConversationsByDate<T extends Dated>(items: T[], now: Date = new Date()): ConversationGroup<T>[] {
  const today = startOfDay(now.getTime());
  const groups = new Map<string, ConversationGroup<T> & { rank: number }>();
  for (const item of items) {
    const { rank, key, label } = item.pinned
      ? { rank: -5e6, key: "pinned", label: "고정됨" }
      : bucketOf(timeOf(item), today);
    let group = groups.get(key);
    if (!group) {
      group = { rank, key, label, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank).map(({ key, label, items }) => ({ key, label, items }));
}

/** 제목에 검색어가 들어 있는 것만. 대소문자는 가리지 않고, 빈 검색어는 전부 통과. */
export function filterByTitle<T extends { title: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

/**
 * 제목을 [앞, 일치, 뒤] 로 나눈다 — 일치한 곳을 칠하려고. 처음 일치한 한 곳만.
 * 일치가 없거나, 소문자로 바꾸면 글자 수가 달라지는 제목(위치를 되돌릴 수 없다)이면 null.
 */
export function splitMatch(title: string, query: string): [string, string, string] | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const lower = title.toLowerCase();
  if (lower.length !== title.length) return null;
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  return [title.slice(0, at), title.slice(at, at + needle.length), title.slice(at + needle.length)];
}
