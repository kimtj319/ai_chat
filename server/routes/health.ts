import { Router } from "express";
import { checkHealth } from "../vllm/client.js";

export const healthRouter = Router();

/**
 * 모델 서버 확인은 10초 동안 같이 쓴다. 열린 탭마다 15초마다 이 경로를 부르는데, 그때마다
 * 엔드포인트마다 /models 를 부르면 탭 수에 비례해 모델 서버를 두드린다(탭 100개면 초당
 * 7번). 진행 중인 확인도 같이 기다린다. 10초 늦은 상태는 15초 주기의 배너에 충분히 새롭다.
 */
const HEALTH_TTL_MS = 10_000;
let recent: { at: number; result: ReturnType<typeof checkHealth> } | null = null;

function sharedHealth(): ReturnType<typeof checkHealth> {
  const now = Date.now();
  if (!recent || now - recent.at >= HEALTH_TTL_MS) {
    const result = checkHealth();
    recent = { at: now, result };
    // 실패는 기억하지 않는다 — 다음 확인이 바로 다시 해 본다.
    result.catch(() => {
      if (recent?.result === result) recent = null;
    });
  }
  return recent.result;
}

healthRouter.get("/health", async (req, res, next) => {
  try {
    // Reachable signed out (middleware/auth.ts explains why), but then it is a
    // liveness ping and nothing more: which servers this app talks to, at which
    // addresses, and which models they serve is not something to hand out to
    // anyone who can reach the port.
    if (req.user?.status !== "active") {
      res.json({ backend: "ok", authenticated: false });
      return;
    }
    const result = await sharedHealth();
    res.json({
      backend: "ok",
      // "ok" when at least one endpoint answers; the per-endpoint breakdown
      // below says which ones are actually up.
      vllm: result.ok ? "ok" : "unreachable",
      ...(result.model ? { model: result.model } : {}),
      latencyMs: result.latencyMs,
      endpoints: result.endpoints,
    });
  } catch (err) {
    next(err);
  }
});
