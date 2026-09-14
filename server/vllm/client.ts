import { config } from "../config.js";
import type { VllmEndpoint } from "../config.js";
import { IMAGE_TOKEN_CEILING } from "../attachments/sniff.js";
import { endpointsRevision, listEndpoints } from "./endpoints.js";
import { probeModels, type ModelCapability } from "./capability.js";

function requestHeaders(endpoint: VllmEndpoint, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (endpoint.apiKey) headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  return headers;
}

interface ModelsListResponse {
  data?: Array<{ id: string; max_model_len?: number }>;
}

export interface CatalogEntry {
  id: string;
  label: string;
  baseUrl: string;
  /**
   * null when the server reports no max_model_len — which the LiteLLM gateway
   * at the LiteLLM gateway does for every one of its models (measured
   * 2026-09-12). Everything downstream must therefore have a real fallback;
   * see attachments/budget.ts, whose numbers are what /api/models publishes.
   */
  maxModelLen: number | null;
  /** Whether this model's endpoint answered the most recent probe. */
  reachable: boolean;
  /** What the model can actually do, measured once per model (capability.ts). */
  capability: ModelCapability;
}

/**
 * List one endpoint's models and classify each one. Models that nothing can
 * use are dropped here rather than in the route, so `resolveModel` can never
 * fall back onto one either.
 */
async function fetchEndpointModels(endpoint: VllmEndpoint, signal?: AbortSignal): Promise<CatalogEntry[]> {
  const res = await fetch(`${endpoint.baseUrl}/models`, {
    headers: requestHeaders(endpoint, false),
    signal,
  });
  if (!res.ok) {
    throw new Error(`vLLM /models responded ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ModelsListResponse;
  const listed = body.data ?? [];
  const verdicts = await probeModels(endpoint, listed.map((m) => m.id));
  const entries: CatalogEntry[] = [];
  for (const m of listed) {
    const verdict = verdicts.get(m.id);
    if (verdict?.capability === "unusable") {
      // One line per exclusion, naming the model and the server's own words.
      console.warn(`[vllm] excluding "${m.id}" on ${endpoint.label} (${endpoint.baseUrl}): ${verdict.reason}`);
      continue;
    }
    if (!verdict?.capability) {
      // Undecided (see capability.ts): keep it, assume chat, and say so.
      console.warn(`[vllm] "${m.id}" on ${endpoint.label}: ${verdict?.reason ?? "no verdict"} — listing it as chat`);
    }
    entries.push({
      id: m.id,
      label: endpoint.label,
      baseUrl: endpoint.baseUrl,
      maxModelLen: typeof m.max_model_len === "number" ? m.max_model_len : null,
      reachable: true,
      capability: verdict?.capability ?? "chat",
    });
  }
  return entries;
}

let cachedCatalog: { entries: CatalogEntry[]; fetchedAt: number; revision: number } | null = null;
const MODEL_CACHE_TTL_MS = 60_000;
/**
 * What each endpoint served the last time it answered. A restarting GPU host
 * used to make its models vanish from the picker mid-conversation; they stay
 * listed with reachable:false instead, and the default-model pick below skips
 * them, so the other endpoints stay exactly as usable as before.
 */
const lastKnownByEndpoint = new Map<string, CatalogEntry[]>();

/**
 * Every model served by every configured endpoint, in endpoint order.
 * One unreachable endpoint is logged and flagged rather than failing the whole
 * catalog — the other models stay usable.
 */
export async function fetchCatalog(signal?: AbortSignal, force = false): Promise<CatalogEntry[]> {
  const endpoints = listEndpoints();
  // The revision changes when .model is edited, so a new endpoint does not have
  // to wait out the rest of the cache window.
  if (
    !force &&
    cachedCatalog &&
    cachedCatalog.revision === endpointsRevision() &&
    Date.now() - cachedCatalog.fetchedAt < MODEL_CACHE_TTL_MS
  ) {
    return cachedCatalog.entries;
  }
  const results = await Promise.allSettled(endpoints.map((ep) => fetchEndpointModels(ep, signal)));
  const entries: CatalogEntry[] = [];
  results.forEach((r, i) => {
    const endpoint = endpoints[i]!;
    if (r.status === "fulfilled") {
      lastKnownByEndpoint.set(endpoint.baseUrl, r.value);
      entries.push(...r.value);
      return;
    }
    console.warn(`[vllm] endpoint "${endpoint.label}" unreachable:`, r.reason);
    for (const stale of lastKnownByEndpoint.get(endpoint.baseUrl) ?? []) {
      entries.push({ ...stale, label: endpoint.label, reachable: false });
    }
  });
  if (entries.length > 0) cachedCatalog = { entries, fetchedAt: Date.now(), revision: endpointsRevision() };
  return entries;
}

/**
 * Drop the cached catalog. Called after an endpoint is added or removed so the
 * new model is listed on the next request instead of after the 60s TTL — the
 * point of the feature is that a pasted address works immediately.
 */
export function invalidateCatalog(): void {
  cachedCatalog = null;
}

/** Backward-compatible flat list of model ids across all endpoints. */
export async function fetchModels(signal?: AbortSignal): Promise<string[]> {
  return (await fetchCatalog(signal)).map((e) => e.id);
}

/**
 * Resolve a requested model id to the endpoint that serves it. An unknown or
 * empty id falls back to the first available model so a stale selection (or a
 * conversation created before a model was removed) still answers.
 */
export async function resolveModel(
  requested?: string,
): Promise<{ model: string; endpoint: VllmEndpoint; maxModelLen: number | null; capability: ModelCapability }> {
  const catalog = await fetchCatalog();
  if (catalog.length === 0) throw new Error("No vLLM endpoint returned any model");

  const wanted = requested?.trim();
  const match = wanted ? catalog.find((e) => e.id === wanted) : undefined;
  // The fallback prefers a reachable CHAT model: an unreachable entry is kept
  // in the catalog for the UI but must never become the default, and neither
  // must an embedding or rerank model — defaulting onto one would turn "no
  // model selected" into a conversation that cannot answer anything.
  const chosen =
    match ??
    catalog.find((e) => e.reachable && e.capability === "chat") ??
    catalog.find((e) => e.capability === "chat") ??
    catalog.find((e) => e.reachable) ??
    catalog[0]!;
  const endpoints = listEndpoints();
  const endpoint = endpoints.find((ep) => ep.baseUrl === chosen.baseUrl) ?? endpoints[0] ?? config.vllmEndpoints[0]!;
  // maxModelLen is the context budget every request has to fit into, so the
  // caller gets it here rather than re-fetching the catalog.
  return { model: chosen.id, endpoint, maxModelLen: chosen.maxModelLen, capability: chosen.capability };
}

/** The default model id (first model of the first reachable endpoint). */
export async function getCurrentModel(): Promise<string> {
  return (await resolveModel()).model;
}

export interface EndpointHealth {
  label: string;
  baseUrl: string;
  ok: boolean;
  models: string[];
  latencyMs: number;
}

export async function checkHealth(): Promise<{
  ok: boolean;
  model?: string;
  latencyMs: number;
  endpoints: EndpointHealth[];
}> {
  const start = Date.now();
  const endpoints = await Promise.all(
    listEndpoints().map(async (ep): Promise<EndpointHealth> => {
      const t0 = Date.now();
      try {
        const models = await fetchEndpointModels(ep, AbortSignal.timeout(5000));
        return { label: ep.label, baseUrl: ep.baseUrl, ok: true, models: models.map((m) => m.id), latencyMs: Date.now() - t0 };
      } catch {
        return { label: ep.label, baseUrl: ep.baseUrl, ok: false, models: [], latencyMs: Date.now() - t0 };
      }
    }),
  );
  const firstOk = endpoints.find((e) => e.ok && e.models.length > 0);
  return {
    ok: endpoints.some((e) => e.ok),
    ...(firstOk ? { model: firstOk.models[0] } : {}),
    latencyMs: Date.now() - start,
    endpoints,
  };
}

export interface ChatToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface PromptTokenCount {
  tokens: number;
  /** max_model_len as the tokenizer itself reports it; null when the call failed. */
  maxModelLen: number | null;
  /** False when /tokenize was unreachable and `tokens` is a character-based estimate. */
  exact: boolean;
}

/**
 * Measured 2026-09-11 on the 27B endpoint: a 227k-token prompt tokenizes in
 * 0.5–6.8s depending on server load (143ms for a short one). 5s was not enough
 * and dropped us onto the estimate exactly when the exact count matters most.
 */
const TOKENIZE_TIMEOUT_MS = 20_000;

/**
 * Fallback for when /tokenize is unreachable. One pass over the payload,
 * charging each ASCII punctuation character a token, four "wordish" ASCII
 * characters a token, and 4.5 non-ASCII bytes a token.
 *
 * Why not a single characters- or bytes-per-token ratio: no such ratio exists.
 * Measured against this model's tokenizer, bytes per token spans 4.97 for
 * English prose and 4.64 for Korean prose down to 1.94 for dense minified JSON
 * — and a tool result is JSON. Any divisor big enough to stop over-counting
 * prose under-counts JSON badly, and under-counting is not a soft failure:
 * simulated against the live tokenizer (2026-09-11), an estimate 0.64x of the
 * truth on a window-filling JSON prompt never lets the ladder engage, so all
 * three attempts overflow and the turn is lost, where the old rule's 0.97x
 * estimate recovered on the first retry.
 *
 * What separates the two is punctuation density, which is why it is counted.
 * Estimate / truth over the six measured payloads: English prose 1.30, Korean
 * prose 1.07, Korean+English markdown 1.44, source code 1.48, dense minified
 * JSON 1.24, an http_fetch result (prose inside JSON) 1.21. Never below 1.0, so
 * the ladder still engages before the window; never above 1.5, where the old
 * "2 per character" rule reached 2.43 on English and put a 60k-token English
 * conversation at ~200k, compacting and trimming it for nothing.
 */
function estimatePromptTokens(messages: unknown[], tools?: ChatToolDef[]): number {
  // Images are counted from their recorded cost, never as prose. Base64 is
  // ~1.33 characters per byte of image and reads to the rule below as dense
  // punctuation-free word text: measured 2026-09-11, a 1920x1080 image
  // estimated 310,634 tokens against an actual 2,098 (148x), which is above the
  // whole window — on a /tokenize outage the ladder would have gutted a
  // conversation that fits comfortably.
  let imageTokens = 0;
  const withoutImages = messages.map((message) => {
    const m = message as { content?: unknown; imageTokens?: unknown };
    if (!Array.isArray(m.content)) return message;
    const costs = Array.isArray(m.imageTokens) ? (m.imageTokens as number[]) : [];
    let seen = 0;
    const parts = m.content.filter((part) => {
      if ((part as { type?: string })?.type !== "image_url") return true;
      // An image with no recorded cost is charged the server's ceiling: this
      // estimate exists to keep the ladder engaging, so it must never
      // under-count.
      imageTokens += costs[seen++] ?? IMAGE_TOKEN_CEILING;
      return false;
    });
    const { imageTokens: _nonWire, ...rest } = m;
    return { ...rest, content: parts };
  });
  const payload = JSON.stringify({ messages: withoutImages, tools: tools ?? [] });
  let punctuation = 0;
  let wordish = 0;
  let nonAsciiBytes = 0;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    if (c > 0x7f) {
      // UTF-8 width: 2 bytes below U+0800, 2 per surrogate half (4 per pair), else 3.
      nonAsciiBytes += c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? 2 : 3;
    } else if (c === 32 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      wordish++;
    } else {
      punctuation++;
    }
  }
  return Math.ceil(punctuation + wordish / 4 + nonAsciiBytes / 4.5) + messages.length * 8 + imageTokens;
}

/**
 * Drop the non-wire fields of a message list before it is serialised.
 *
 * `imageTokens` (chat/historyBuilder.ts) is ours, not the API's. This server
 * happens to tolerate it — sent deliberately, /chat/completions and /tokenize
 * both answered 200 and the same 130 tokens (measured 2026-09-11), because the
 * chat template only reads role/content/tool_calls — but tolerance is not a
 * contract: other OpenAI-compatible servers reject unknown fields outright, and
 * a future vLLM is free to start. Internal bookkeeping does not belong in a
 * request to another process. Both request builders below go through this.
 */
export function toWire(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || !("imageTokens" in message)) return message;
    const { imageTokens: _nonWire, ...wire } = message as Record<string, unknown>;
    return wire;
  });
}

/**
 * Exact prompt token count from vLLM's own tokenizer. It is served at the
 * server root — {baseUrl} minus the trailing /v1, since /v1/tokenize is a 404 —
 * and takes the same payload shape as /chat/completions. `tools` must be passed
 * when tools are offered: the schemas are real prompt tokens (measured
 * 2026-09-11 on the 27B endpoint: 55 tokens for one short message, 304 for the
 * same message plus one tool schema).
 */
/**
 * Endpoints that answered /tokenize with 404, remembered for the life of the
 * process. Not every OpenAI-compatible server has vLLM's tokenizer route: the
 * LiteLLM gateway does not (measured 2026-09-12). Left
 * unremembered, every single turn on such an endpoint pays a wasted round trip
 * and logs a stack trace before falling back to the estimate it was always
 * going to use. Only a 404 is remembered — a timeout or a 5xx is a server
 * having a bad moment, and the next turn should try again.
 */
const endpointsWithoutTokenizer = new Set<string>();

export async function countPromptTokens(
  endpoint: VllmEndpoint,
  model: string,
  messages: unknown[],
  tools?: ChatToolDef[],
  /** The turn's abort signal, so Stop does not have to wait out the timeout below. */
  signal?: AbortSignal,
): Promise<PromptTokenCount> {
  const root = endpoint.baseUrl.replace(/\/v1$/, "");
  if (endpointsWithoutTokenizer.has(root)) {
    return { tokens: estimatePromptTokens(messages, tools), maxModelLen: null, exact: false };
  }
  const timeout = AbortSignal.timeout(TOKENIZE_TIMEOUT_MS);
  try {
    const res = await fetch(`${root}/tokenize`, {
      method: "POST",
      headers: requestHeaders(endpoint, true),
      body: JSON.stringify({
        model,
        // Image content parts are counted exactly here (measured: text-only 64
        // tokens, text + 64x64 image 130, and the chat completion reported 130
        // too), so the exact-budget machinery keeps working with attachments.
        messages: toWire(messages),
        add_generation_prompt: true,
        ...(tools ? { tools } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.status === 404) {
      endpointsWithoutTokenizer.add(root);
      console.warn(
        `[vllm] ${root}/tokenize is not served (404); using the character estimate for this endpoint from now on. ` +
          "Exact prompt token counts are unavailable there, so the context ladder works from an estimate.",
      );
      return { tokens: estimatePromptTokens(messages, tools), maxModelLen: null, exact: false };
    }
    if (!res.ok) throw new Error(`vLLM /tokenize responded ${res.status}`);
    const body = (await res.json()) as { count?: number; max_model_len?: number };
    if (typeof body.count !== "number") throw new Error("vLLM /tokenize returned no count");
    return {
      tokens: body.count,
      maxModelLen: typeof body.max_model_len === "number" ? body.max_model_len : null,
      exact: true,
    };
  } catch (err) {
    // A cancelled turn is not a tokenizer outage — let the caller's abort path
    // handle it instead of logging a warning and budgeting a doomed request.
    if (signal?.aborted) throw err;
    // A tokenizer outage must not break chat: fall back to the estimate.
    console.warn("[vllm] /tokenize unavailable, using character estimate:", err);
    return { tokens: estimatePromptTokens(messages, tools), maxModelLen: null, exact: false };
  }
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: unknown[];
  stream: true;
  stream_options: { include_usage: true };
  temperature: number;
  top_p: number;
  max_tokens: number;
  presence_penalty: number;
  frequency_penalty: number;
  seed?: number;
  /**
   * Values the Qwen3.8 servers actually accept. Measured 2026-09-11 against
   * both endpoints: sending "high" is rejected with
   *   400 "Unexpected reasoning effort high. Supported types are xhigh
   *        (default), medium, and low."
   * so the UI's top level maps to "xhigh", not "high".
   */
  reasoning_effort?: "low" | "medium" | "xhigh";
  thinking_token_budget?: number;
  /**
   * Optional because a model whose reasoning cannot be steered is sent no
   * reasoning fields at all — see reasoningProfiles.ts, where wise-lloa-max
   * measured 58 runs with prompt_tokens pinned at 145 no matter what was sent.
   */
  chat_template_kwargs?: { enable_thinking: boolean };
  tools?: ChatToolDef[];
  /**
   * "none" is how a request stops tools: the schemas stay on the wire byte-for-
   * byte (they render at the front of the prompt, so removing them invalidates
   * the prefix cache) while the model is barred from calling one.
   */
  tool_choice?: "auto" | "none";
}

export interface VllmStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<VllmStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const rawLine of part.split("\n")) {
          const line = rawLine.trimEnd();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice("data:".length).trimStart();
          if (!payload) continue;
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload) as VllmStreamChunk;
          } catch {
            // A chunk boundary should never split a single SSE data line, but
            // if it happens, drop the malformed fragment instead of crashing.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** POST {endpoint}/chat/completions with stream:true, returning parsed SSE chunks. */
export async function streamChatCompletion(
  body: ChatCompletionRequestBody,
  signal: AbortSignal,
  endpoint: VllmEndpoint = config.vllmEndpoints[0]!,
): Promise<AsyncGenerator<VllmStreamChunk>> {
  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: requestHeaders(endpoint, true),
    body: JSON.stringify({ ...body, messages: toWire(body.messages) }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`vLLM /chat/completions responded ${res.status}: ${text.slice(0, 500)}`);
  }
  return parseSseStream(res.body, signal);
}

export interface EmbeddingResult {
  model: string;
  dim: number;
  vector: number[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * POST {endpoint}/embeddings for a single string.
 *
 * Measured 2026-09-12 on the LiteLLM gateway:
 * A typical embedding model answers with dim=1024 and a real
 * usage.prompt_tokens, and the vectors are semantically meaningful —
 * cos("벡터 색인 성능 시험", "검색 엔진 인덱싱 속도 측정") = 0.5170 against
 * cos(same, "오늘 점심 뭐 먹지") = 0.2168.
 *
 * There is no streaming variant and none is wanted: an embedding is one
 * response. The route still delivers it over the existing SSE channel so the
 * client keeps one transport (routes/conversations.ts).
 */
export async function createEmbedding(
  endpoint: VllmEndpoint,
  model: string,
  input: string,
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  const res = await fetch(`${endpoint.baseUrl}/embeddings`, {
    method: "POST",
    headers: requestHeaders(endpoint, true),
    body: JSON.stringify({ model, input }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`embeddings responded ${res.status}: ${text.slice(0, 300)}`);
  }
  let body: { data?: Array<{ embedding?: unknown }>; model?: unknown; usage?: EmbeddingResult["usage"] };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`embeddings returned a non-JSON body: ${text.slice(0, 120)}`);
  }
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((v) => typeof v === "number")) {
    throw new Error("embeddings returned no vector");
  }
  return {
    model: typeof body.model === "string" ? body.model : model,
    dim: vector.length,
    vector: vector as number[],
    ...(body.usage ? { usage: body.usage } : {}),
  };
}
