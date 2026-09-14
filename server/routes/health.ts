import { Router } from "express";
import { checkHealth } from "../vllm/client.js";

export const healthRouter = Router();

healthRouter.get("/health", async (req, res) => {
  // Reachable signed out (middleware/auth.ts explains why), but then it is a
  // liveness ping and nothing more: which servers this app talks to, at which
  // addresses, and which models they serve is not something to hand out to
  // anyone who can reach the port.
  if (req.user?.status !== "active") {
    res.json({ backend: "ok", authenticated: false });
    return;
  }
  const result = await checkHealth();
  res.json({
    backend: "ok",
    // "ok" when at least one endpoint answers; the per-endpoint breakdown
    // below says which ones are actually up.
    vllm: result.ok ? "ok" : "unreachable",
    ...(result.model ? { model: result.model } : {}),
    latencyMs: result.latencyMs,
    endpoints: result.endpoints,
  });
});
