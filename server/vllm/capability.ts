import { config } from "../config.js";
import type { VllmEndpoint } from "../config.js";

/**
 * What a served model can actually do, measured instead of assumed.
 *
 * Why this exists: /v1/models is a list of what the gateway is configured for,
 * not a list of what works. Measured 2026-09-12 against a LiteLLM gateway that
 * listed five models:
 *
 *   a chat model     chat  (tool_calls, image_url parts)
 *   a thinking model chat  (see the trap below)
 *   a stale entry    HTTP 400 "Invalid model name" — listed, unusable
 *   an embedder      400 on chat; /v1/embeddings 200, dim=1024
 *   a reranker       400 on chat and on embeddings; /v1/rerank 200
 *
 * Three of the five would have appeared in the model picker and failed the
 * moment anyone chose them. So each newly seen model gets one tiny request,
 * chat -> embeddings -> rerank, stopping at the first success.
 *
 * THE THINKING-MODEL TRAP: that thinking model spends its whole budget on
 * `reasoning` and returns an empty `content` when max_tokens is 1 (measured: at
 * 200 tokens it answers correctly). Judging capability on the text would
 * therefore delete a perfectly good model from the picker. The test is
 * therefore structural: HTTP 200 with a `choices` array is chat, whatever is
 * inside it.
 */
export type ModelCapability = "chat" | "embedding" | "rerank" | "unusable";

export interface CapabilityVerdict {
  /**
   * "unusable" means the server refused all three on its own terms — the model
   * is dropped from the catalog, so the API never actually publishes that value
   * (it is in the union because the frontend's type carries it too).
   *
   * null is different and means UNDECIDED: the probe never got an answer it
   * could trust (transport failure, 5xx, or a 401/403 that is about the
   * endpoint's key rather than this model). Nothing is cached and the model is
   * published as "chat", which is what the app assumed before probes existed —
   * hiding a model because a GPU host was busy for a moment would be a worse
   * answer than letting the send fail loudly.
   */
  capability: ModelCapability | null;
  /** Why, in one line, for the log. */
  reason: string;
}

/**
 * Probes are cached per endpoint+model for the process's lifetime, so the 60s
 * catalog refresh does not re-probe what it already knows. Only DECISIVE
 * verdicts are cached (see probeModel): a model that answered, or one the
 * server refused on its own terms.
 */
const verdicts = new Map<string, CapabilityVerdict>();

const cacheKey = (baseUrl: string, model: string): string => `${baseUrl}\u0000${model}`;

/** Test only: forget every verdict so the next catalog build re-probes. */
export function clearCapabilityCache(): void {
  verdicts.clear();
}

export function cachedCapability(baseUrl: string, model: string): CapabilityVerdict | undefined {
  return verdicts.get(cacheKey(baseUrl, model));
}

/**
 * 20 seconds. A chat probe is one token, but these are shared GPU hosts and a
 * queued request waits; the alternative to waiting is declaring a live model
 * dead, which is the failure this whole file exists to prevent.
 */
const PROBE_TIMEOUT_MS = 20_000;

interface Attempt {
  ok: boolean;
  /** True when the server answered on its own terms (any HTTP status). */
  answered: boolean;
  status: number;
  detail: string;
}

async function post(endpoint: VllmEndpoint, path: string, body: unknown, shape: (json: unknown) => boolean): Promise<Attempt> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, answered: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, answered: true, status: res.status, detail: `HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, " ").trim()}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, answered: true, status: res.status, detail: `HTTP 200 with a non-JSON body: ${text.slice(0, 60)}` };
  }
  if (!shape(json)) {
    return { ok: false, answered: true, status: res.status, detail: `HTTP 200 but the body was not the expected shape: ${text.slice(0, 120)}` };
  }
  return { ok: true, answered: true, status: res.status, detail: `HTTP 200` };
}

const hasChoices = (json: unknown): boolean => Array.isArray((json as { choices?: unknown })?.choices);
const hasEmbedding = (json: unknown): boolean => {
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) && data.length > 0 && Array.isArray((data[0] as { embedding?: unknown })?.embedding);
};
const hasRerankResults = (json: unknown): boolean => Array.isArray((json as { results?: unknown })?.results);

/**
 * One probe round for one model. Never throws: an unknown verdict is an
 * unknown verdict, not a broken catalog.
 */
export async function probeModel(endpoint: VllmEndpoint, model: string): Promise<CapabilityVerdict> {
  const cached = verdicts.get(cacheKey(endpoint.baseUrl, model));
  if (cached) return cached;

  const chat = await post(
    endpoint,
    "/chat/completions",
    // One word in, one token out: the cheapest request that still exercises the
    // real path. `content` is NOT inspected — see the thinking-model note above.
    { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
    hasChoices,
  );
  if (chat.ok) return remember(endpoint.baseUrl, model, { capability: "chat", reason: "chat: HTTP 200 with choices[]" });

  // A transport failure or a server-side error says nothing about the model.
  // Excluding it would take a working model out of the picker because a GPU
  // host was busy for a moment, so leave the verdict unknown and uncached: the
  // next catalog refresh probes again.
  if (!chat.answered || chat.status >= 500) {
    return { capability: null, reason: `undecided (${chat.detail})` };
  }
  // 401/403 is the endpoint's key being wrong, not this model being unusable —
  // and every model behind that endpoint would fail the same way. Excluding
  // them all would empty the picker and blame the models.
  if (chat.status === 401 || chat.status === 403) {
    return { capability: null, reason: `undecided (auth: ${chat.detail})` };
  }

  const embedding = await post(endpoint, "/embeddings", { model, input: "ping" }, hasEmbedding);
  if (embedding.ok) return remember(endpoint.baseUrl, model, { capability: "embedding", reason: "embeddings: HTTP 200 with data[0].embedding" });

  const rerank = await post(endpoint, "/rerank", { model, query: "ping", documents: ["pong"] }, hasRerankResults);
  if (rerank.ok) return remember(endpoint.baseUrl, model, { capability: "rerank", reason: "rerank: HTTP 200 with results[]" });

  // Decisively refused on all three: the gateway lists it but nothing can use
  // it (measured: wise-lloa-max-v1.1.1, 400 "Invalid model name"). The chat
  // refusal is quoted in full because it is the one an operator has to act on;
  // the other two are only there to show they were tried.
  return remember(endpoint.baseUrl, model, {
    capability: "unusable",
    reason: `${chat.detail} (embeddings: HTTP ${embedding.status}, rerank: HTTP ${rerank.status})`,
  });
}

function remember(baseUrl: string, model: string, verdict: CapabilityVerdict): CapabilityVerdict {
  verdicts.set(cacheKey(baseUrl, model), verdict);
  return verdict;
}

/**
 * Classify a list of models served by one endpoint. Returns the verdict per
 * model id; already-probed models cost nothing.
 */
export async function probeModels(endpoint: VllmEndpoint, models: string[]): Promise<Map<string, CapabilityVerdict>> {
  const out = new Map<string, CapabilityVerdict>();
  if (!config.modelCapabilityProbe) {
    // Skipped by configuration: assume chat, which is what the app did before
    // this file existed. Better to be explicit about the assumption than to
    // silently hide the whole catalog.
    for (const model of models) out.set(model, { capability: "chat", reason: "probe disabled (MODEL_CAPABILITY_PROBE=0)" });
    return out;
  }
  const results = await Promise.all(models.map(async (model) => [model, await probeModel(endpoint, model)] as const));
  for (const [model, verdict] of results) out.set(model, verdict);
  return out;
}
