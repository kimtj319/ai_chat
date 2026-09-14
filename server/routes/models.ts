import { Router, type Request, type Response } from "express";
import { fetchCatalog, invalidateCatalog } from "../vllm/client.js";
import {
  endpointSource,
  isEnvEndpoint,
  listEndpoints,
  normalizeBaseUrl,
  probeEndpoint,
  removeFileEndpoint,
  upsertFileEndpoint,
  writableEndpointsFile,
} from "../vllm/endpoints.js";
import { attachmentBudget } from "../attachments/budget.js";
import { MAX_IMAGE_EDGE } from "../attachments/sniff.js";
import { config } from "../config.js";
import { reasoningIsFixed } from "../chat/reasoningProfiles.js";

export const modelsRouter = Router();

modelsRouter.get("/models", async (_req, res) => {
  try {
    const catalog = await fetchCatalog();
    res.json({
      // `models` stays a flat string[] so existing clients keep working.
      models: catalog.map((e) => e.id),
      // The default must be a chat model: an embedding or rerank model as
      // "current" would hand a new conversation a model that cannot answer.
      current:
        catalog.find((e) => e.reachable && e.capability === "chat")?.id ??
        catalog.find((e) => e.capability === "chat")?.id ??
        catalog[0]?.id ??
        "",
      // Richer per-model info: which endpoint serves it, at which address,
      // whether that address answered the last probe, its context window, and
      // the attachment limits derived from that window — the UI can then block
      // an upload before it is sent and show a running total, from the same
      // numbers the server enforces.
      catalog: catalog.map((e) => {
        // Emitted for every entry, unreachable ones included and with the
        // configured fallback window when a model reports none, so the UI can
        // always gate an upload instead of guessing. The LiteLLM gateway
        // reports no max_model_len at all (measured 2026-09-12), so this
        // fallback is the live path for those models, not a corner case: the
        // numbers below are ATTACHMENT_DEFAULT_MESSAGE_TOKENS and half of it,
        // never null and never NaN.
        const budget = attachmentBudget(e.maxModelLen);
        return {
          id: e.id,
          endpoint: e.label,
          baseUrl: e.baseUrl,
          reachable: e.reachable,
          // Measured, not declared (vllm/capability.ts). "rerank" is published
          // rather than hidden so the picker can show it and say why it is not
          // selectable — a reranker needs a query plus a document list, which
          // no chat composer can express. Models that can do nothing at all are
          // already gone from the catalog.
          capability: e.capability,
          // True when the reasoning controls do nothing on this model, so the
          // picker can say so instead of offering a choice that is not there.
          // wise-lloa-max held prompt_tokens at 145 across 58 runs whatever was
          // sent, and kept thinking through enable_thinking:false every time.
          reasoningFixed: reasoningIsFixed(e.id),
          maxModelLen: e.maxModelLen,
          attachments: {
            maxMessageTokens: budget.messageTokens,
            maxFileTokens: budget.singleFileTokens,
            // Transport, not tokens: the server rescales any image to at most
            // 16,386 tokens, so bytes and tokens cap different things.
            maxFileBytes: Math.max(config.attachmentMaxImageBytes, config.attachmentMaxTextBytes),
            maxImageWidth: MAX_IMAGE_EDGE,
            maxImageHeight: MAX_IMAGE_EDGE,
          },
        };
      }),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Failed to reach vLLM" });
  }
});

/**
 * Managing serving endpoints from the UI.
 *
 * This lets a request make the server fetch an arbitrary address, and the app
 * has no authentication of its own. MODEL_ADMIN_TOKEN is the only gate; with it
 * unset the calls still work (otherwise the feature is dead on arrival for this
 * deployment) but every mutation is logged with the caller's address, and GET
 * reports `unprotected` so the UI can say so out loud. There is deliberately no
 * private-range block: the real servers are on public addresses (211.39.x.x),
 * so such a rule would block exactly the machines this exists for.
 */
function clientAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function adminAllowed(req: Request, res: Response): boolean {
  // Adding an endpoint makes the server fetch an address of the caller's
  // choosing, and every user of the app can then be pointed at it. That is an
  // administrator's decision. The comment above predates accounts existing;
  // now that they do, the account's role is the gate, and MODEL_ADMIN_TOKEN
  // stays as an extra lock rather than the only one.
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "관리자만 모델 엔드포인트를 변경할 수 있습니다.", code: "not_admin" });
    return false;
  }
  if (!config.modelAdminToken) return true;
  if (req.get("X-Model-Admin-Token") === config.modelAdminToken) return true;
  res.status(403).json({ error: "이 서버에서는 모델 엔드포인트를 변경할 권한이 필요합니다.", code: "forbidden" });
  return false;
}

modelsRouter.get("/models/endpoints", async (_req, res) => {
  const endpoints = await Promise.all(
    listEndpoints().map(async (endpoint) => {
      const probe = await probeEndpoint(endpoint.baseUrl, endpoint.apiKey);
      return {
        label: endpoint.label,
        baseUrl: endpoint.baseUrl,
        source: endpointSource(endpoint.baseUrl),
        reachable: probe.ok,
        models: probe.models,
        maxModelLen: probe.maxModelLen,
        latencyMs: probe.latencyMs,
      };
    }),
  );
  res.json({ unprotected: config.modelAdminToken.length === 0, endpoints });
});

modelsRouter.post("/models/endpoints", async (req, res) => {
  if (!adminAllowed(req, res)) return;
  const body = req.body ?? {};
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!baseUrl) {
    return res.status(400).json({ error: "주소를 알아볼 수 없습니다. 예: 10.0.0.10:8000 또는 http://10.0.0.10:8000/v1", code: "invalid_url" });
  }
  if (listEndpoints().some((e) => e.baseUrl.toLowerCase() === baseUrl.toLowerCase())) {
    return res.status(409).json({ error: `이미 등록된 주소입니다: ${baseUrl}`, code: "duplicate" });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const probe = await probeEndpoint(baseUrl, apiKey);
  if (!probe.ok) {
    const message =
      probe.code === "unreachable"
        ? `${baseUrl}/models 에 연결하지 못했습니다 (${probe.detail}).`
        : `${baseUrl}/models 가 모델 목록이 아닌 응답을 반환했습니다. vLLM 주소가 맞는지 확인해 주세요 (받은 내용: ${probe.detail}).`;
    return res.status(502).json({ error: message, code: probe.code });
  }

  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : baseUrl;
  try {
    await upsertFileEndpoint({ label, baseUrl, apiKey });
  } catch (err) {
    console.error("[models] could not write the endpoints file:", err);
    return res.status(500).json({ error: `엔드포인트 파일(${writableEndpointsFile()})에 기록하지 못했습니다.`, code: "write_failed" });
  }
  invalidateCatalog();
  console.log(
    `[models] endpoint ADDED by ${clientAddress(req)}: ${label} ${baseUrl} ` +
      `models=${probe.models.join(",")} apiKey=${apiKey ? "provided" : "none"} adminToken=${config.modelAdminToken ? "required" : "UNSET"}`,
  );
  res.status(201).json({
    label,
    baseUrl,
    models: probe.models,
    maxModelLen: probe.maxModelLen,
    // The servers answer 200 even with a deliberately wrong bearer token
    // (measured), so a key can be stored and sent but never confirmed.
    note: apiKey ? "API 키는 저장되어 요청에 사용되지만, 이 서버는 키가 틀려도 200을 돌려주므로 유효성은 확인할 수 없습니다." : undefined,
  });
});

modelsRouter.delete("/models/endpoints", async (req, res) => {
  if (!adminAllowed(req, res)) return;
  const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
  if (!baseUrl) return res.status(400).json({ error: "baseUrl 이 필요합니다.", code: "invalid_url" });
  if (isEnvEndpoint(baseUrl)) {
    // VLLM_ENDPOINTS is the deployment's own configuration. Even when the file
    // also lists this URL, deleting the file's line would leave the endpoint
    // being served from the environment — a 204 that changed nothing visible.
    return res.status(409).json({
      error: `${baseUrl} 은(는) VLLM_ENDPOINTS 환경변수로 설정된 항목이라 여기서 지울 수 없습니다. 환경변수를 수정해 주세요.`,
      code: "forbidden",
    });
  }
  const removed = await removeFileEndpoint(baseUrl);
  if (!removed) return res.status(404).json({ error: `등록되지 않은 주소입니다: ${baseUrl}` });
  invalidateCatalog();
  console.log(`[models] endpoint REMOVED by ${clientAddress(req)}: ${baseUrl} adminToken=${config.modelAdminToken ? "required" : "UNSET"}`);
  res.status(204).end();
});
