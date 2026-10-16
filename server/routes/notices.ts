/**
 * 공지사항. 읽기는 로그인한 모두, 쓰기·고치기·지우기는 관리자만.
 *
 *   GET    /api/notices              목록 + 이 계정이 아직 안 본 수
 *   POST   /api/notices/seen         "다 봤다" — 머리의 알림 표시를 끈다
 *   POST   /api/admin/notices        새 공지 (관리자)
 *   PATCH  /api/admin/notices/:id    고치기 (관리자)
 *   DELETE /api/admin/notices/:id    지우기 (관리자)
 */
import express from "express";
import { requireAdmin } from "../middleware/auth.js";
import {
  createNotice,
  deleteNotice,
  listNotices,
  markNoticesSeen,
  noticesSeenAt,
  unreadCount,
  updateNotice,
  type Notice,
} from "../storage/noticeStore.js";
import { getUser } from "../storage/userStore.js";

export const noticesRouter = express.Router();

/** 쓴 사람 이름을 붙인다. 계정이 지워졌으면 null — 화면이 id 를 쓴다. */
async function withAuthorNames(notices: Notice[]): Promise<Array<Notice & { authorName: string | null }>> {
  const names = new Map<string, string | null>();
  for (const id of new Set(notices.map((n) => n.authorId))) {
    const user = await getUser(id).catch(() => null);
    names.set(id, user?.name ?? null);
  }
  return notices.map((n) => ({ ...n, authorName: names.get(n.authorId) ?? null }));
}

noticesRouter.get("/notices", async (req, res, next) => {
  try {
    const notices = await listNotices();
    const seenAt = await noticesSeenAt(req.ownerId!);
    res.json({ notices: await withAuthorNames(notices), seenAt, unread: unreadCount(notices, seenAt) });
  } catch (err) {
    next(err);
  }
});

noticesRouter.post("/notices/seen", async (req, res, next) => {
  try {
    const seenAt = await markNoticesSeen(req.ownerId!);
    res.json({ seenAt, unread: 0 });
  } catch (err) {
    next(err);
  }
});

noticesRouter.post("/admin/notices", requireAdmin, async (req, res, next) => {
  try {
    const notice = await createNotice({ authorId: req.ownerId!, title: req.body?.title, body: req.body?.body });
    if (!notice) {
      res.status(400).json({ error: "제목을 적어 주세요.", code: "notice_title_required" });
      return;
    }
    const [named] = await withAuthorNames([notice]);
    res.status(201).json({ notice: named });
  } catch (err) {
    next(err);
  }
});

noticesRouter.patch("/admin/notices/:id", requireAdmin, async (req, res, next) => {
  try {
    const notice = await updateNotice(req.params.id, { title: req.body?.title, body: req.body?.body });
    if (!notice) {
      res.status(400).json({ error: "없는 공지이거나 제목이 비어 있습니다.", code: "notice_invalid" });
      return;
    }
    const [named] = await withAuthorNames([notice]);
    res.json({ notice: named });
  } catch (err) {
    next(err);
  }
});

noticesRouter.delete("/admin/notices/:id", requireAdmin, async (req, res, next) => {
  try {
    const ok = await deleteNotice(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "없는 공지입니다.", code: "notice_not_found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
