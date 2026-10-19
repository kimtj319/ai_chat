import { Router } from "express";
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
import { reasoningIsFixed, reasoningProfileLabel } from "../chat/reasoningProfiles.js";
import { modelAccessFor } from "../vllm/access.js";
import { modelOwnerOf, removeModelOwner, setModelOwner } from "../storage/modelOwners.js";
import { clientAddress } from "./rateLimit.js";

export const modelsRouter = Router();

modelsRouter.get("/models", async (req, res) => {
  try {
    // Only what this account may use (vllm/access.ts) — a model it cannot use
    // is not offered at all rather than offered and refused.
    const access = await modelAccessFor(req.user);
    const catalog = (await fetchCatalog()).filter(access.allows);
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
          // How REASONING_PROFILES treats this model, shown on the admin page.
          reasoningProfile: reasoningProfileLabel(e.id),
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
 * Any signed-in account may register an endpoint. What it registers is usable
 * by itself, its group and the accounts that may use every model
 * (vllm/access.ts); changing or deleting it is limited to the registrant and
 * those accounts (below). Every mutation is logged with the caller's address.
 * There is deliberately no private-range block: the real servers are on public
 * addresses, so such a rule would block exactly the machines this exists for.
 */

modelsRouter.get("/models/endpoints", async (req, res, next) => {
  try {
    const access = await modelAccessFor(req.user);
    const endpoints = await Promise.all(
      listEndpoints().filter(access.allows).map(async (endpoint) => {
        const probe = await probeEndpoint(endpoint.baseUrl, endpoint.apiKey);
        const source = endpointSource(endpoint.baseUrl);
        return {
          label: endpoint.label,
          baseUrl: endpoint.baseUrl,
          source,
          // Registered by this account — and so deletable by it.
          mine: access.owns(endpoint.baseUrl),
          // Registered by someone else in this account's group.
          shared: access.sharedWithGroup(endpoint.baseUrl),
          deletable: source === "file" && (access.privileged || access.owns(endpoint.baseUrl)),
          reachable: probe.ok,
          models: probe.models,
          // The models this endpoint is limited to; null = all it lists.
          allowedModels: endpoint.models && endpoint.models.length > 0 ? endpoint.models : null,
          maxModelLen: probe.maxModelLen,
          latencyMs: probe.latencyMs,
        };
      }),
    );
    res.json({ privileged: access.privileged, endpoints });
  } catch (err) {
    next(err);
  }
});

/**
 * A list longer than this has to be narrowed before it is added. Every listed
 * model is probed with a small chat request (vllm/capability.ts) and shown in
 * the picker; OpenRouter listed 465 (2026-10-17), which would be 465 billed
 * requests on every restart and an unusable picker.
 */
const MAX_UNFILTERED_MODELS = 50;

function probeFailureMessage(baseUrl: string, probe: { code?: string; detail?: string }): string {
  return probe.code === "unreachable"
    ? `${baseUrl}/models 에 연결하지 못했습니다 (${probe.detail}).`
    : `${baseUrl}/models 가 모델 목록이 아닌 응답을 반환했습니다. OpenAI 호환 주소(…/v1)가 맞는지 확인해 주세요 (받은 내용: ${probe.detail}).`;
}

/** Strings from the request, de-duplicated; null when the field is absent or not a list. */
function requestedModels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean))];
}

/**
 * The models a server offers, without adding it — so the dialog can let the
 * user pick before anything is written.
 */
modelsRouter.post("/models/endpoints/probe", async (req, res, next) => {
  try {
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    if (!baseUrl) {
      return res.status(400).json({ error: "주소를 알아볼 수 없습니다. 예: 10.0.0.10:8000 또는 http://10.0.0.10:8000/v1", code: "invalid_url" });
    }
    // For an endpoint already registered, its stored key is used when none is typed.
    const known = listEndpoints().find((e) => e.baseUrl.toLowerCase() === baseUrl.toLowerCase());
    const typed = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    const probe = await probeEndpoint(baseUrl, typed || known?.apiKey);
    if (!probe.ok) return res.status(502).json({ error: probeFailureMessage(baseUrl, probe), code: probe.code });
    res.json({ baseUrl, models: probe.models, latencyMs: probe.latencyMs, mustChoose: probe.models.length > MAX_UNFILTERED_MODELS });
  } catch (err) {
    next(err);
  }
});

modelsRouter.post("/models/endpoints", async (req, res, next) => {
  try {
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
    if (!probe.ok) return res.status(502).json({ error: probeFailureMessage(baseUrl, probe), code: probe.code });

    const chosen = requestedModels(body.models) ?? [];
    const unknown = chosen.filter((m) => !probe.models.includes(m));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `이 서버에 없는 모델입니다: ${unknown.slice(0, 5).join(", ")}`, code: "unknown_models" });
    }
    if (chosen.length === 0 && probe.models.length > MAX_UNFILTERED_MODELS) {
      return res.status(400).json({
        error: `이 서버는 모델 ${probe.models.length}개를 내줍니다. 사용할 모델을 골라 주세요.`,
        code: "models_required",
      });
    }

    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : baseUrl;
    try {
      await upsertFileEndpoint({ label, baseUrl, apiKey, ...(chosen.length > 0 ? { models: chosen } : {}) });
      await setModelOwner(baseUrl, req.ownerId);
    } catch (err) {
      console.error("[models] could not write the endpoints file:", err);
      return res.status(500).json({ error: `엔드포인트 파일(${writableEndpointsFile()})에 기록하지 못했습니다.`, code: "write_failed" });
    }
    invalidateCatalog();
    console.log(
      `[models] endpoint ADDED by ${req.ownerId}@${clientAddress(req)}: ${label} ${baseUrl} ` +
        `models=${chosen.length > 0 ? `${chosen.join(",")} (of ${probe.models.length})` : probe.models.join(",")} ` +
        `apiKey=${apiKey ? "provided" : "none"}`,
    );
    res.status(201).json({
      label,
      baseUrl,
      models: chosen.length > 0 ? chosen : probe.models,
      maxModelLen: probe.maxModelLen,
      // The servers answer 200 even with a deliberately wrong bearer token
      // (measured), so a key can be stored and sent but never confirmed.
      note: apiKey ? "API 키는 저장되어 요청에 사용되지만, 이 서버는 키가 틀려도 200을 돌려주므로 유효성은 확인할 수 없습니다." : undefined,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Change which models an already-registered endpoint is limited to. An empty
 * list means "all of them", which a long list is not allowed to fall back to.
 */
modelsRouter.patch("/models/endpoints", async (req, res, next) => {
  try {
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    if (!baseUrl) return res.status(400).json({ error: "baseUrl 이 필요합니다.", code: "invalid_url" });
    const access = await modelAccessFor(req.user);
    if (!access.privileged && (await modelOwnerOf(baseUrl)) !== req.ownerId) {
      return res.status(403).json({ error: "직접 등록한 서버만 바꿀 수 있습니다.", code: "not_owner" });
    }
    if (isEnvEndpoint(baseUrl)) {
      return res.status(409).json({
        error: `${baseUrl} 은(는) VLLM_ENDPOINTS 환경변수로 설정된 항목이라 여기서 바꿀 수 없습니다. 환경변수의 네 번째 칸(모델1;모델2)을 수정해 주세요.`,
        code: "forbidden",
      });
    }
    const current = listEndpoints().find((e) => e.baseUrl.toLowerCase() === baseUrl.toLowerCase());
    if (!current) return res.status(404).json({ error: `등록되지 않은 주소입니다: ${baseUrl}` });
    const chosen = requestedModels(req.body?.models);
    if (chosen === null) return res.status(400).json({ error: "models 목록이 필요합니다.", code: "invalid_models" });
    const probe = await probeEndpoint(current.baseUrl, current.apiKey);
    if (!probe.ok) return res.status(502).json({ error: probeFailureMessage(current.baseUrl, probe), code: probe.code });
    const unknown = chosen.filter((m) => !probe.models.includes(m));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `이 서버에 없는 모델입니다: ${unknown.slice(0, 5).join(", ")}`, code: "unknown_models" });
    }
    if (chosen.length === 0 && probe.models.length > MAX_UNFILTERED_MODELS) {
      return res.status(400).json({ error: `모델이 ${probe.models.length}개라 모두 쓰도록 둘 수 없습니다. 사용할 모델을 골라 주세요.`, code: "models_required" });
    }
    try {
      await upsertFileEndpoint({ label: current.label, baseUrl: current.baseUrl, apiKey: current.apiKey, ...(chosen.length > 0 ? { models: chosen } : {}) });
    } catch (err) {
      console.error("[models] could not write the endpoints file:", err);
      return res.status(500).json({ error: `엔드포인트 파일(${writableEndpointsFile()})에 기록하지 못했습니다.`, code: "write_failed" });
    }
    invalidateCatalog();
    console.log(`[models] endpoint MODELS by ${req.ownerId}@${clientAddress(req)}: ${current.baseUrl} models=${chosen.length > 0 ? chosen.join(",") : "(all)"}`);
    res.json({ baseUrl: current.baseUrl, allowedModels: chosen.length > 0 ? chosen : null });
  } catch (err) {
    next(err);
  }
});

modelsRouter.delete("/models/endpoints", async (req, res, next) => {
  try {
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    if (!baseUrl) return res.status(400).json({ error: "baseUrl 이 필요합니다.", code: "invalid_url" });
    const access = await modelAccessFor(req.user);
    if (!access.privileged && (await modelOwnerOf(baseUrl)) !== req.ownerId) {
      return res.status(403).json({ error: "직접 등록한 모델만 지울 수 있습니다.", code: "not_owner" });
    }
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
    await removeModelOwner(baseUrl);
    invalidateCatalog();
    console.log(`[models] endpoint REMOVED by ${req.ownerId}@${clientAddress(req)}: ${baseUrl}`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
