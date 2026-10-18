export type BoardPostStatus = "open" | "closed";

/** 글 하나에 달린 답변. 글 파일 안에 함께 산다 — 항상 같이 읽히기 때문이다. */
export interface BoardReply {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  /** 마지막으로 고친 때. 고친 적이 없으면 없다 — 화면이 "(수정됨)" 을 붙이는 근거다. */
  editedAt?: string;
}

/**
 * 문의 글. 저장되는 모양이다.
 *
 * 작성자는 id 만 담는다. 이름은 계정이 바뀌면 따라 바뀌어야 하므로 읽을 때
 * 붙인다 — 문서 목록이 등록자를 다루는 방식과 같다.
 */
export interface BoardPost {
  id: string;
  /** 사람이 부르는 번호(#12). 이 필드가 생기기 전 글은 처음 목록을 읽을 때 작성 순으로 채운다. */
  number?: number;
  title: string;
  body: string;
  /** 사용자가 자유롭게 적는다. 소문자로 모으고 중복을 없앤 뒤 저장한다. */
  tags: string[];
  status: BoardPostStatus;
  authorId: string;
  replies: BoardReply[];
  createdAt: string;
  updatedAt: string;
  /** 제목·본문·라벨을 마지막으로 고친 때. 상태를 바꾸거나 답변이 달린 것은 고친 것이 아니다. */
  editedAt?: string;
  /** 누가 언제 닫았는가. 다시 열면 지운다. */
  closedBy?: string;
  closedAt?: string;
}

/** 화면에 나가는 모양 — 작성자 이름이 붙고, 목록에서는 본문과 답변이 빠진다. */
export interface BoardReplyView extends BoardReply {
  authorName: string | null;
  /** 지금 보는 사람이 이 답변을 고칠 수 있는가. 글의 canManage 와 같은 규칙을 답변에 댄다. */
  canEdit: boolean;
}

export interface BoardPostView extends Omit<BoardPost, "replies"> {
  authorName: string | null;
  replies: BoardReplyView[];
  /** 지금 보는 사람이 이 글의 상태를 바꾸거나 지울 수 있는가. 화면이 묻지 않아도 되게. */
  canManage: boolean;
}

export interface BoardPostSummary
  extends Omit<BoardPost, "replies" | "body" | "closedBy" | "closedAt"> {
  authorName: string | null;
  replyCount: number;
  canManage: boolean;
}

export type BoardErrorCode = "invalid_input" | "not_found" | "forbidden";
