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
  MAX_TAGS,
  MAX_TITLE_CHARS,
  addReply,
  createPost,
  deletePost,
  getPost,
  listPosts,
  setStatus,
} from "../storage/boardStore.js";
import { getUser } from "../storage/userStore.js";
import { isValidId } from "../storage/paths.js";
import type {
  BoardErrorCode,
  BoardPost,
  BoardPostStatus,
  BoardPostSummary,
  BoardPostView,
} from "../types.js";
import type { Request } from "express";

export const boardRouter = express.Router();

function fail(res: express.Response, status: number, code: BoardErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

/** 글을 바꿀 수 있는 사람: 쓴 사람, 또는 관리자. 이 한 줄이 규칙의 전부다. */
function canManage(req: Request, post: BoardPost): boolean {
  return post.authorId === req.ownerId || req.user?.role === "admin";
}

/**
 * 계정 id 에 이름을 붙인다. 계정이 지워졌으면 null 로 두고 화면이 id 를 쓴다 —
 * 없는 이름을 지어내지 않는다. 같은 사람이 여러 번 나와도 한 번만 읽는다.
 */
async function nameLookup(ids: Iterable<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set(ids)) {
    const user = await getUser(id).catch(() => null);
    if (user) names.set(id, user.name);
  }
  return names;
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
  const names = await nameLookup([post.authorId, ...post.replies.map((r) => r.authorId)]);
  return {
    ...post,
    authorName: names.get(post.authorId) ?? null,
    replies: post.replies.map((r) => ({ ...r, authorName: names.get(r.authorId) ?? null })),
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
    const names = await nameLookup(posts.map((p) => p.authorId));
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
    if (!isValidId(req.params.id)) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    const post = await getPost(req.params.id);
    if (!post) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
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
    res.status(201).json({ post: await toView(post, req) });
  } catch (err) {
    next(err);
  }
});

/** 열고 닫기. 여기가 권한이 걸리는 첫 자리다. */
boardRouter.patch("/board/:id", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    const post = await getPost(req.params.id);
    if (!post) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    if (!canManage(req, post)) {
      return fail(res, 403, "forbidden", "글을 쓴 사람과 관리자만 상태를 바꿀 수 있습니다.");
    }
    const wanted = (req.body as { status?: unknown } | undefined)?.status;
    if (wanted !== "open" && wanted !== "closed") {
      return fail(res, 400, "invalid_input", "상태는 open 또는 closed 여야 합니다.");
    }
    const updated = await setStatus(post.id, wanted as BoardPostStatus, req.ownerId);
    if (!updated) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    res.json({ post: await toView(updated, req) });
  } catch (err) {
    next(err);
  }
});

boardRouter.delete("/board/:id", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    const post = await getPost(req.params.id);
    if (!post) return fail(res, 404, "not_found", "존재하지 않는 글입니다.");
    if (!canManage(req, post)) {
      return fail(res, 403, "forbidden", "글을 쓴 사람과 관리자만 지울 수 있습니다.");
    }
    await deletePost(post.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { MAX_TAGS };
