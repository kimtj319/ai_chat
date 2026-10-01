import { Router } from "express";
import { getConversation } from "../storage/conversationStore.js";
import { isValidId } from "../storage/paths.js";
import {
  getShare,
  isValidShareToken,
  readShareAttachment,
  saveShare,
  shareTokenFor,
  ShareTokenTakenError,
} from "../storage/shareStore.js";

/**
 * 대화 공유 링크.
 *
 * 공유하는 쪽(로그인 필요):
 *   GET /conversations/:id/share → { token | null }   이미 공유했으면 그 토큰
 *   PUT /conversations/:id/share { token } → { token } 지금 모습으로 사본을 뜨거나 고친다
 *
 * 링크를 연 쪽(로그인 없음 — middleware/auth.ts PUBLIC_SHARED_PATH):
 *   GET /shared/:token                  사본(제목·메시지)
 *   GET /shared/:token/attachments/:aid 사본에 딸린 첨부
 *
 * 받는 쪽에는 읽기만 있다. 사본은 원본 대화와 이어져 있지 않으므로 받는 사람이 무엇을
 * 해도 원본에 닿을 길이 없다 — 이어서 묻기·고치기·지우기 모두 원본 경로에만 있고, 그
 * 경로는 소유자의 로그인을 요구한다.
 */
export const shareRouter = Router();

shareRouter.get("/conversations/:id/share", async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: "Not found" });
    res.json({ token: await shareTokenFor(req.ownerId, req.params.id) });
  } catch (err) {
    next(err);
  }
});

shareRouter.put("/conversations/:id/share", async (req, res, next) => {
  try {
    const { id } = req.params;
    const token: unknown = req.body?.token;
    if (!isValidId(id)) return res.status(404).json({ error: "Not found" });
    if (!isValidShareToken(token)) return res.status(400).json({ error: "공유 토큰 형식이 잘못되었습니다." });
    const conversation = await getConversation(req.ownerId, id);
    if (!conversation) return res.status(404).json({ error: "대화를 찾을 수 없습니다." });
    if (conversation.messages.length === 0) return res.status(400).json({ error: "공유할 메시지가 없습니다." });
    res.json({ token: await saveShare(req.ownerId, conversation, token) });
  } catch (err) {
    if (err instanceof ShareTokenTakenError) return res.status(409).json({ error: err.message });
    next(err);
  }
});

shareRouter.get("/shared/:token", async (req, res, next) => {
  try {
    const share = await getShare(req.params.token);
    if (!share) return res.status(404).json({ error: "공유된 대화를 찾을 수 없습니다." });
    // 링크를 아는 사람만 보는 내용이다 — 공용 캐시에 남지 않게 한다.
    res.setHeader("Cache-Control", "private, no-store");
    res.json(share);
  } catch (err) {
    next(err);
  }
});

shareRouter.get("/shared/:token/attachments/:aid", async (req, res, next) => {
  try {
    const found = await readShareAttachment(req.params.token, req.params.aid);
    if (!found) return res.status(404).json({ error: "Not found" });
    const { meta, bytes } = found;
    // routes/attachments.ts 와 같은 머리글 — 사용자가 올린 바이트를 앱 자신의 출처에서 내준다.
    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(bytes);
  } catch (err) {
    next(err);
  }
});
