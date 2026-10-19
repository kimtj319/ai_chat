/**
 * 문의 게시판.
 *
 * 읽는 것은 로그인한 모두에게 열려 있다 — 게시판의 뜻이 그것이다. 바꾸는 것은
 * **작성자와 관리자**만 할 수 있고, 그 판단은 이 파일 한 곳(canManage)에만 있다.
 * 저장소는 누가 부탁했는지 묻지 않고 시키는 대로 쓰므로, 권한이 여러 곳에
 * 흩어지면 한 곳을 빠뜨렸을 때 조용히 열린다.
 */
import express from "express";
import {
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  addReply,
  cleanEditText,
  createPost,
  deletePost,
  editPost,
  editReply,
  getPost,
  listPosts,
  normalizeTags,
  setStatus,
} from "../storage/boardStore.js";
import { userNamesById } from "../storage/userStore.js";
import { notifyBoardReply } from "../mail/boardReplyMail.js";
import { isValidId } from "../storage/paths.js";
import type {
  BoardErrorCode,
  BoardPost,
  BoardPostStatus,
  BoardPostSummary,
  BoardPostView,
} from "../types.js";
import type { Request } from "express";
import { sendError } from "./respond.js";

export const boardRouter = express.Router();

const fail = sendError<BoardErrorCode>;

/**
 * 글이나 답변을 바꿀 수 있는 사람: 쓴 사람, 또는 관리자. 이 한 줄이 규칙의 전부다.
 * 답변에도 같은 줄을 댄다 — 글을 쓴 사람이라도 남의 답변은 그 사람의 말이라 못 고친다.
 */
function canManage(req: Request, record: { authorId: string }): boolean {
  return record.authorId === req.ownerId || req.user?.role === "admin";
}

/**
 * 글 하나를 찾고, 없으면 404 로 답한다(null). 이상한 id 도 같은 404 다.
 * 권한은 보지 않는다 — 읽기는 모두에게 열려 있고, 바꾸는 쪽이 canManage 를 따로 본다.
 */
async function loadPostOr404(req: Request, res: express.Response): Promise<BoardPost | null> {
  const post = isValidId(req.params.id) ? await getPost(req.params.id) : null;
  if (!post) fail(res, 404, "not_found", "존재하지 않는 글입니다.");
  return post;
}

function toSummary(post: BoardPost, names: Map<string, string>, req: Request): BoardPostSummary {
  const { replies, body, closedBy, closedAt, ...rest } = post;
  void body;
  void closedBy;
  void closedAt;
  return {
    ...rest,
    authorName: names.get(post.authorId) ?? null,
    replyCount: replies.length,
    canManage: canManage(req, post),
  };
}

async function toView(post: BoardPost, req: Request): Promise<BoardPostView> {
  // 계정이 지워졌으면 이름은 null — 화면이 id 를 쓴다. 없는 이름을 지어내지 않는다.
  const names = await userNamesById([post.authorId, ...post.replies.map((r) => r.authorId)]);
  return {
    ...post,
    authorName: names.get(post.authorId) ?? null,
    replies: post.replies.map((r) => ({ ...r, authorName: names.get(r.authorId) ?? null, canEdit: canManage(req, r) })),
    canManage: canManage(req, post),
  };
}

/**
 * 목록. 상태로 거르지 않고 **전부** 준다.
 *
 * 열림/닫힘 탭은 화면이 가르는 것이고, 탭마다 건수를 함께 보여 주려면 어차피
 * 양쪽을 다 알아야 한다. 서버가 걸러 보내면 화면이 "닫힘 0개" 인지 "안 세어
 * 봤다" 인지 구분하지 못한다.
 */
boardRouter.get("/board", async (req, res, next) => {
  try {
    const posts = await listPosts();
    const names = await userNamesById(posts.map((p) => p.authorId));
    res.json({
      posts: posts.map((p) => toSummary(p, names, req)),
      // 지금 쓰이고 있는 태그. 새 글을 쓸 때 이미 있는 말을 고르게 해서
      // "검색"과 "검색어"가 따로 생기는 것을 조금이라도 줄인다.
      tags: [...new Set(posts.flatMap((p) => p.tags))].sort(),
    });
  } catch (err) {
    next(err);
  }
});

boardRouter.get("/board/:id", async (req, res, next) => {
  try {
    const post = await loadPostOr404(req, res);
    if (!post) return;
    res.json({ post: await toView(post, req) });
  } catch (err) {
    next(err);
  }
});

boardRouter.post("/board", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { title?: unknown; body?: unknown; tags?: unknown };
    const post = await createPost({
      authorId: req.ownerId,
      title: body.title,
      body: body.body,
      tags: body.tags,
    });
    if (!post) return fail(res, 400, "invalid_input", `제목을 적어 주세요 (${MAX_TITLE_CHARS}자까지).`);
    res.status(201).json({ post: await toView(post, req) });
  } catch (err) {
    next(err);
  }
});

boardRouter.post("/board/:id/replies", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    const text = (req.body as { body?: unknown } | undefined)?.body;
    const post = await addReply(req.params.id, req.ownerId, text);
    if (!post) {
      // 글이 없어서인지 내용이 비어서인지 갈라서 말해 준다.
      const exists = await getPost(req.params.id);
      return exists
        ? fail(res, 400, "invalid_input", "답변 내용을 적어 주세요.")
        : fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    }
    // 글쓴이에게 메일로 알린다. 기다리지 않는다 — 답변은 이미 저장됐고, 메일
    // 서버가 느리거나 죽어 있어도 답변 요청이 그 때문에 늦거나 실패하면 안 된다.
    void notifyBoardReply(post, post.replies[post.replies.length - 1]);
    res.status(201).json({ post: await toView(post, req) });
  } catch (err) {
    next(err);
  }
});

/**
 * 열고 닫기, 그리고 제목·본문·라벨 고치기. 여기가 권한이 걸리는 첫 자리다.
 *
 * 준 칸만 바꾼다 — 상태만 주면 상태만, 라벨만 주면 라벨만. 하나라도 틀리면
 * 아무것도 바꾸지 않는다: 다 따져 본 다음에 쓴다. 본문이 들어오므로 새 글과
 * 같은 크기까지 받는다.
 */
boardRouter.patch("/board/:id", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    const post = await loadPostOr404(req, res);
    if (!post) return;
    if (!canManage(req, post)) {
      return fail(res, 403, "forbidden", "글을 쓴 사람과 관리자만 글을 고치거나 상태를 바꿀 수 있습니다.");
    }
    const input = (req.body ?? {}) as { status?: unknown; title?: unknown; body?: unknown; tags?: unknown };
    const wanted = input.status;
    if (wanted !== undefined && wanted !== "open" && wanted !== "closed") {
      return fail(res, 400, "invalid_input", "상태는 open 또는 closed 여야 합니다.");
    }
    const changes: { title?: string; body?: string; tags?: string[] } = {};
    if (input.title !== undefined) {
      const title = cleanEditText(input.title, MAX_TITLE_CHARS);
      if (!title) return fail(res, 400, "invalid_input", `제목을 적어 주세요 (${MAX_TITLE_CHARS}자까지).`);
      changes.title = title;
    }
    if (input.body !== undefined) {
      // 본문은 비워도 된다 — 새 글도 제목만으로 올릴 수 있다.
      const body = cleanEditText(input.body, MAX_BODY_CHARS);
      if (body === null) return fail(res, 400, "invalid_input", `본문은 ${MAX_BODY_CHARS.toLocaleString()}자까지 쓸 수 있습니다.`);
      changes.body = body;
    }
    if (input.tags !== undefined) changes.tags = normalizeTags(input.tags);
    const editing = Object.keys(changes).length > 0;
    if (!editing && wanted === undefined) return fail(res, 400, "invalid_input", "바꿀 것이 없습니다.");

    let updated: BoardPost | null = post;
    if (editing) updated = await editPost(post.id, changes);
    if (updated && wanted !== undefined) updated = await setStatus(post.id, wanted as BoardPostStatus, req.ownerId);
    if (!updated) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    res.json({ post: await toView(updated, req) });
  } catch (err) {
    next(err);
  }
});

/** 답변 고치기. 답변을 쓴 사람과 관리자만 — 달 때와 같은 한도로 따진다. */
boardRouter.patch("/board/:id/replies/:replyId", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    const post = await loadPostOr404(req, res);
    if (!post) return;
    const reply = post.replies.find((r) => r.id === req.params.replyId);
    if (!reply) return fail(res, 404, "not_found", "존재하지 않는 답변입니다.");
    if (!canManage(req, reply)) {
      return fail(res, 403, "forbidden", "답변을 쓴 사람과 관리자만 고칠 수 있습니다.");
    }
    const raw = (req.body as { body?: unknown } | undefined)?.body;
    const text = cleanEditText(raw, MAX_BODY_CHARS);
    if (!text) {
      return typeof raw === "string" && text === null
        ? fail(res, 400, "invalid_input", `답변은 ${MAX_BODY_CHARS.toLocaleString()}자까지 쓸 수 있습니다.`)
        : fail(res, 400, "invalid_input", "답변 내용을 적어 주세요.");
    }
    const updated = await editReply(post.id, reply.id, text);
    // 그 사이 글이 지워졌다.
    if (!updated) return fail(res, 404, "not_found", "존재하지 않는 답변입니다.");
    res.json({ post: await toView(updated, req) });
  } catch (err) {
    next(err);
  }
});

boardRouter.delete("/board/:id", async (req, res, next) => {
  try {
    const post = await loadPostOr404(req, res);
    if (!post) return;
    if (!canManage(req, post)) {
      return fail(res, 403, "forbidden", "글을 쓴 사람과 관리자만 지울 수 있습니다.");
    }
    await deletePost(post.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
