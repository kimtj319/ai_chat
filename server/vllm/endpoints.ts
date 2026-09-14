import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config, parseEndpointEntries } from "../config.js";
import { writeFileAtomic } from "../storage/atomic.js";
import { withLock } from "../storage/mutex.js";
import type { VllmEndpoint } from "../config.js";

/**
 * Serving endpoints from an editable file, merged with VLLM_ENDPOINTS.
 *
 * Why a file at all: the deployment runs this app in a container where only
 * `data` and `log` are bind-mounted. An endpoint list baked into the image (or
 * into the container's env) cannot be changed without a rebuild or a docker cp,
 * so {DATA_DIR}/.model — which IS on the mounted volume — is the location that
 * makes "start serving a model and it shows up" true in practice.
 *
 * Lookup order, first existing file wins:
 *   1. MODEL_ENDPOINTS_FILE
 *   2. ./.model (the working directory)
 *   3. {DATA_DIR}/.model
 *
 * Format: one `label|baseUrl|apiKey?` per line, `#` comments and blank lines
 * ignored, parsed by the very same function as VLLM_ENDPOINTS.
 */
const FILE_NAME = ".model";

function candidatePaths(): string[] {
  if (config.modelEndpointsFile) return [path.resolve(process.cwd(), config.modelEndpointsFile)];
  return [path.resolve(process.cwd(), FILE_NAME), path.join(config.dataDir, FILE_NAME)];
}

interface FileState {
  path: string | null;
  mtimeMs: number;
  size: number;
  endpoints: VllmEndpoint[];
}

let cached: FileState = { path: null, mtimeMs: 0, size: 0, endpoints: [] };
/**
 * Bumped whenever the file's content changes. vllm/client.ts compares it
 * against the revision its catalog cache was built with, so a new line takes
 * effect on the next refresh instead of at the next restart.
 */
let revision = 0;

export function endpointsRevision(): number {
  return revision;
}

/** Stat the candidates and re-read only when the resolved file or its mtime/size changed. */
function fileEndpoints(): VllmEndpoint[] {
  let found: { path: string; mtimeMs: number; size: number } | null = null;
  for (const candidate of candidatePaths()) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        found = { path: candidate, mtimeMs: stat.mtimeMs, size: stat.size };
        break;
      }
    } catch {
      // Not there — try the next candidate. A missing file is the normal case.
    }
  }

  if (!found) {
    if (cached.path !== null) {
      cached = { path: null, mtimeMs: 0, size: 0, endpoints: [] };
      revision++;
    }
    return cached.endpoints;
  }
  if (cached.path === found.path && cached.mtimeMs === found.mtimeMs && cached.size === found.size) {
    return cached.endpoints;
  }

  let endpoints: VllmEndpoint[] = [];
  try {
    endpoints = parseEndpointEntries(fs.readFileSync(found.path, "utf8").split("\n"), process.env.VLLM_API_KEY || "");
    console.log(`[vllm] ${found.path}: ${endpoints.length} endpoint(s) — ${endpoints.map((e) => e.label).join(", ") || "none"}`);
  } catch (err) {
    // A half-written file must not take the configured endpoints down with it.
    console.warn(`[vllm] could not read ${found.path}, keeping the previous endpoint list:`, err);
    endpoints = cached.endpoints;
  }
  cached = { path: found.path, mtimeMs: found.mtimeMs, size: found.size, endpoints };
  revision++;
  return endpoints;
}

/** Normalised key for de-duplication: the same server written two ways is one endpoint. */
const keyOf = (endpoint: VllmEndpoint): string => endpoint.baseUrl.replace(/\/+$/, "").toLowerCase();

/**
 * The endpoints to serve from: environment first (so the default model — the
 * catalog's first entry — does not move under an existing deployment), then the
 * file's own additions. A URL in both keeps the file's label and key, because
 * the file is the thing an operator just edited.
 */
export function listEndpoints(): VllmEndpoint[] {
  const fromFile = fileEndpoints();
  // The built-in VLLM_BASE_URL fallback applies only when nothing at all is
  // configured; a .model file IS configuration, so it must not be joined by a
  // default endpoint nobody asked for.
  const fromEnv = config.vllmEnvEndpoints.length > 0 ? config.vllmEnvEndpoints : fromFile.length > 0 ? [] : config.vllmEndpoints;

  const overrides = new Map(fromFile.map((endpoint) => [keyOf(endpoint), endpoint]));
  const merged: VllmEndpoint[] = [];
  const seen = new Set<string>();
  for (const endpoint of fromEnv) {
    const key = keyOf(endpoint);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(overrides.get(key) ?? endpoint);
  }
  for (const endpoint of fromFile) {
    const key = keyOf(endpoint);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(endpoint);
  }
  return merged;
}

/** Where the endpoints came from, for the startup log. */
export function endpointsSource(): string {
  return cached.path ? `${config.vllmEnvEndpoints.length} from env + ${cached.endpoints.length} from ${cached.path}` : "env only";
}

/** True when VLLM_ENDPOINTS declares this URL, whatever the file also says. */
export function isEnvEndpoint(baseUrl: string): boolean {
  const key = keyOf({ baseUrl } as VllmEndpoint);
  return config.vllmEnvEndpoints.some((endpoint) => keyOf(endpoint) === key);
}

/**
 * Which source owns this URL. The environment wins when both declare it,
 * because that is the one that decides whether it can be deleted: removing the
 * file's line would leave the endpoint still being served from the env, so the
 * UI must not offer a delete that cannot take effect.
 */
export function endpointSource(baseUrl: string): "file" | "env" {
  if (isEnvEndpoint(baseUrl)) return "env";
  const key = keyOf({ baseUrl } as VllmEndpoint);
  return fileEndpoints().some((endpoint) => keyOf(endpoint) === key) ? "file" : "env";
}

/**
 * Where a new entry is written: the file already in use, or {DATA_DIR}/.model.
 * The default is deliberately the data directory and not the working directory —
 * in the container only data/ and log/ are mounted, so a file written anywhere
 * else would vanish with the next image.
 */
export function writableEndpointsFile(): string {
  if (cached.path) return cached.path;
  if (config.modelEndpointsFile) return path.resolve(process.cwd(), config.modelEndpointsFile);
  return path.join(config.dataDir, FILE_NAME);
}

const FILE_HEADER =
  "# Serving endpoints, one per line: label|baseUrl|apiKey(optional)\n" +
  "# '#' comments and blank lines are ignored. Merged with VLLM_ENDPOINTS.\n" +
  "# Edited by the app when an endpoint is added through /api/models/endpoints.\n";

/**
 * Add (or replace) one endpoint in the file, preserving every other line —
 * comments included, because an operator's notes about which host is which are
 * the reason to keep a file at all.
 */
export async function upsertFileEndpoint(endpoint: VllmEndpoint): Promise<void> {
  await withLock("model-endpoints-file", async () => {
    const target = writableEndpointsFile();
    let existing = "";
    try {
      existing = await fsp.readFile(target, "utf8");
    } catch {
      existing = FILE_HEADER;
    }
    const key = keyOf(endpoint);
    const line = [endpoint.label, endpoint.baseUrl, ...(endpoint.apiKey ? [endpoint.apiKey] : [])].join("|");
    const lines = existing.split("\n");
    let replaced = false;
    const next = lines.map((raw) => {
      const parsed = parseEndpointEntries([raw], "")[0];
      if (!parsed || keyOf(parsed) !== key) return raw;
      replaced = true;
      return line;
    });
    if (!replaced) {
      while (next.length > 0 && next[next.length - 1]!.trim() === "") next.pop();
      next.push(line);
    }
    await writeFileAtomic(target, `${next.join("\n").replace(/\n+$/, "")}\n`);
  });
  // Force the next listEndpoints() to re-read even if the mtime granularity
  // would have hidden a write in the same millisecond.
  cached = { path: null, mtimeMs: 0, size: 0, endpoints: [] };
  revision++;
}

/** Remove an endpoint from the file. False when the file does not define it. */
export async function removeFileEndpoint(baseUrl: string): Promise<boolean> {
  const removed = await withLock("model-endpoints-file", async () => {
    const target = writableEndpointsFile();
    let existing: string;
    try {
      existing = await fsp.readFile(target, "utf8");
    } catch {
      return false;
    }
    const key = keyOf({ baseUrl } as VllmEndpoint);
    const kept = existing.split("\n").filter((raw) => {
      const parsed = parseEndpointEntries([raw], "")[0];
      return !parsed || keyOf(parsed) !== key;
    });
    if (kept.length === existing.split("\n").length) return false;
    await writeFileAtomic(target, `${kept.join("\n").replace(/\n+$/, "")}\n`);
    return true;
  });
  if (removed) {
    cached = { path: null, mtimeMs: 0, size: 0, endpoints: [] };
    revision++;
  }
  return removed;
}

/**
 * Normalise whatever the user pasted: a bare `host:port`, a URL with no scheme,
 * a trailing slash, or the full `.../v1`. Returns null for anything that is not
 * an http(s) address.
 */
export function normalizeBaseUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  // "host:port" is the common paste; vLLM's OpenAI API lives under /v1.
  return `${url.origin}${pathname || "/v1"}`;
}

export type ProbeFailure = "unreachable" | "not_vllm";

export interface ProbeResult {
  ok: boolean;
  code?: ProbeFailure;
  detail?: string;
  models: string[];
  maxModelLen: number | null;
  latencyMs: number;
}

/**
 * Is there really a vLLM at this address?
 *
 * HTTP 200 is not the test. Measured 2026-09-11: this very app answers
 * GET /v1/models with 200 and an HTML body (Express falls through to
 * index.html), so an operator who pastes the web address would register the web
 * server as a model server. The shape is the test — object:"list" and a
 * non-empty data[] of objects with string ids.
 *
 * The api key cannot be validated at all: the same request with a deliberately
 * wrong bearer token also returned 200, because these servers do not require
 * auth. It is stored, sent, and never confirmed — say so rather than implying a
 * check happened.
 */
export async function probeEndpoint(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
  const started = Date.now();
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    return {
      ok: false,
      code: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
      models: [],
      maxModelLen: null,
      latencyMs: Date.now() - started,
    };
  }
  const latencyMs = Date.now() - started;
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, code: "unreachable", detail: `HTTP ${res.status}`, models: [], maxModelLen: null, latencyMs };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: "not_vllm", detail: text.slice(0, 60), models: [], maxModelLen: null, latencyMs };
  }
  const listed = body as { object?: unknown; data?: unknown };
  const data = Array.isArray(listed.data) ? (listed.data as Array<{ id?: unknown; max_model_len?: unknown }>) : [];
  if (listed.object !== "list" || data.length === 0 || !data.every((m) => typeof m?.id === "string")) {
    return { ok: false, code: "not_vllm", detail: text.slice(0, 60), models: [], maxModelLen: null, latencyMs };
  }
  return {
    ok: true,
    models: data.map((m) => String(m.id)),
    maxModelLen: typeof data[0]!.max_model_len === "number" ? (data[0]!.max_model_len as number) : null,
    latencyMs,
  };
}

/**
 * 5 seconds. Measured against the real targets: a live endpoint answers in
 * ~20-60ms, while a closed port on a live host and an unroutable address both
 * only fail by timing out — so this is the whole cost of a bad paste.
 */
const PROBE_TIMEOUT_MS = 5000;
