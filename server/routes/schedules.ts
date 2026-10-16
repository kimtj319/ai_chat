import { Router } from "express";
import { finishSchedule, GRACE_MS, scheduledPrompt } from "../chat/scheduleRunner.js";
import { listSchedules, updateSchedule } from "../storage/scheduleStore.js";

/**
 * 예약 작업 — 웹페이지 쪽. 늘 호출한 계정 자기 것만 다룬다.
 *
 *   GET  /schedules              목록과 서버 시각(페이지가 시계 차이를 맞춘다)
 *   POST /schedules/:id/cancel   대기 중인 예약 취소
 *   POST /schedules/:id/claim    크롬 예약을 이 탭이 맡는다 — 한 탭만 성공한다
 *   POST /schedules/:id/finish   맡은 예약이 끝났다 { ok, note }
 */
export const schedulesRouter = Router();

/** 페이지 타이머가 몇 초 일찍 깨도 맡을 수 있게. */
const EARLY_CLAIM_MS = 15_000;

schedulesRouter.get("/schedules", async (req, res, next) => {
  try {
    res.json({ now: new Date().toISOString(), tasks: await listSchedules(req.ownerId) });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.post("/schedules/:id/cancel", async (req, res, next) => {
  try {
    const task = await updateSchedule(req.ownerId, req.params.id, (t) =>
      t.status === "pending" ? { ...t, status: "cancelled", finishedAt: new Date().toISOString(), note: "사용자가 취소함" } : null,
    );
    if (!task) return res.status(404).json({ error: "취소할 수 있는 예약이 없습니다." });
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.post("/schedules/:id/claim", async (req, res, next) => {
  try {
    const now = Date.now();
    const task = await updateSchedule(req.ownerId, req.params.id, (t) => {
      const runAt = Date.parse(t.runAt);
      if (t.status !== "pending" || !t.useBrowser) return null;
      if (runAt - now > EARLY_CLAIM_MS || now - runAt > GRACE_MS) return null;
      return { ...t, status: "running", startedAt: new Date(now).toISOString(), note: "AI Console 탭이 실행" };
    });
    if (!task) return res.status(409).json({ error: "지금 맡을 수 있는 예약이 아닙니다(이미 맡았거나 시각이 아님)." });
    res.json({ task, prompt: scheduledPrompt(task) });
  } catch (err) {
    next(err);
  }
});

schedulesRouter.post("/schedules/:id/finish", async (req, res, next) => {
  try {
    const ok = req.body?.ok === true;
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const task = await finishSchedule(req.ownerId, req.params.id, ok ? "done" : "failed", note);
    if (!task) return res.status(404).json({ error: "실행 중인 예약이 아닙니다." });
    res.json({ task });
  } catch (err) {
    next(err);
  }
});
