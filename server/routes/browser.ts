import { Router } from "express";
import { completeBrowserAction } from "../chat/browserBridge.js";
import { truncateToolResult } from "../tools/runner.js";
import { isValidId } from "../storage/paths.js";

/**
 * 크롬 명령의 결과 받기. 웹페이지가 확장 프로그램에서 받은 결과를 그대로 보낸다
 * (chat/browserBridge.ts). 걸린 명령은 계정·대화·호출 id 가 모두 맞아야 풀린다 —
 * 다른 사람의 턴에 결과를 끼워 넣을 수 없다.
 */
export const browserRouter = Router();

browserRouter.post("/conversations/:id/browser-actions/:callId", (req, res) => {
  const { id, callId } = req.params;
  if (!isValidId(id) || !/^[0-9a-f-]{36}$/.test(callId)) return res.status(404).json({ error: "Not found" });
  const body = req.body ?? {};
  const ok = body.ok === true;
  const error = typeof body.error === "string" && body.error.trim() ? body.error.slice(0, 2000) : "브라우저 동작이 실패했습니다.";
  const done = completeBrowserAction(req.ownerId, id, callId, ok ? { ok: true, result: truncateToolResult(body.result) } : { ok: false, error });
  if (!done) return res.status(404).json({ error: "기다리는 브라우저 동작이 없습니다(이미 끝났거나 중지됨)." });
  res.status(204).end();
});
