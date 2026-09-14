/**
 * 주소가 화면을 정한다.
 *
 * 라우터를 두지 않는다 — 화면이 다섯이고 중첩·매개변수 경로가 없어서, 의존성
 * 하나가 값을 하지 못한다. 대신 **해석하는 곳은 한 곳**이어야 한다. 규칙이
 * App 과 게시판 양쪽에 나뉘어 있으면 한쪽만 고쳤을 때 조용히 어긋난다:
 * 주소창에는 글이 찍혀 있는데 화면은 채팅으로 떨어지는 식으로, 아무 오류 없이.
 *
 * 경로(pathname)가 아니라 해시를 쓰는 이유는 서버가 정적 index 하나만 내주기
 * 때문이다. /admin 을 경로로 두면 새로고침에서 404 가 난다.
 */

export type View = "chat" | "admin" | "library" | "documents" | "board";

export const CHAT_HASH = "#/";
export const ADMIN_HASH = "#/admin";
export const LIBRARY_HASH = "#/library";
export const DOCUMENTS_HASH = "#/documents";
export const BOARD_HASH = "#/board";

export const HASHES: Record<View, string> = {
  chat: CHAT_HASH,
  admin: ADMIN_HASH,
  library: LIBRARY_HASH,
  documents: DOCUMENTS_HASH,
  board: BOARD_HASH,
};

export function viewFromHash(hash: string): View {
  if (hash === ADMIN_HASH) return "admin";
  if (hash === LIBRARY_HASH) return "library";
  if (hash === DOCUMENTS_HASH) return "documents";
  // 게시판만 아래에 주소가 더 달린다 — #/board/<글 id>. 글을 읽다 새로고침해도
  // 그 글이 그대로 있어야 하고, 링크로 건네줄 수도 있어야 하기 때문이다.
  if (hash === BOARD_HASH || hash.startsWith(`${BOARD_HASH}/`)) return "board";
  return "chat";
}

/** 글 하나의 주소. id 에 무엇이 들어와도 주소를 깨뜨리지 않게 감싼다. */
export function boardPostHash(postId: string): string {
  return `${BOARD_HASH}/${encodeURIComponent(postId)}`;
}

/** 그 반대. 글이 실려 있지 않으면 null — 곧 목록을 보라는 뜻이다. */
export function boardPostIdFromHash(hash: string): string | null {
  if (!hash.startsWith(`${BOARD_HASH}/`)) return null;
  const raw = hash.slice(BOARD_HASH.length + 1);
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    // 반쪽짜리 % 이스케이프. 주소를 손으로 고치다 이렇게 되는데, 여기서
    // 예외가 나가면 게시판이 통째로 안 열린다.
    return raw || null;
  }
}
