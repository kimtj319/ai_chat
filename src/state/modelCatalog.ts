// Pure helpers over the model catalog: which model is selected, and where it
// actually runs. No React, so both the selector and the sidebar subtitle can
// agree without one importing the other's component.

import type { ModelCatalogEntry } from "../api/types";

/**
 * The model in effect right now. The open conversation's own model wins; with
 * none open it is the one chosen for the next conversation; failing both, the
 * server's default, then the first catalog entry.
 */
export function resolveSelectedModelId(
  catalog: ModelCatalogEntry[],
  current: string,
  conversationModel: string | null,
  lastModel: string,
): string {
  const fallback = current || catalog[0]?.id || "";
  if (conversationModel !== null) return conversationModel || fallback;
  return lastModel || fallback;
}

/**
 * "http://10.0.0.10:8000/v1" -> "10.0.0.10:8000".
 *
 * Strips the scheme and the OpenAI-compatible /v1 suffix, which say nothing
 * about *where* the model runs. Never throws: a value we cannot parse comes
 * back verbatim, because a wrong-looking address is still more useful than a
 * sidebar that crashed.
 */
export function formatEndpointHost(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (raw.length === 0) return raw;

  let host = "";
  let path = "";
  try {
    const parsed = new URL(raw);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    // Not a URL the platform accepts — fall back to string surgery.
    const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const slash = withoutScheme.indexOf("/");
    host = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
    path = slash === -1 ? "" : withoutScheme.slice(slash);
  }

  if (host.length === 0) return raw;
  const trimmedPath = path.replace(/\/v\d+\/?$/i, "").replace(/\/+$/, "");
  return `${host}${trimmedPath}`;
}

export interface EndpointLabel {
  text: string;
  /** Renders in --danger: a stale "실행 중" under a dead endpoint is worse. */
  unreachable: boolean;
  /** Full value for the title attribute; the label itself is ellipsised. */
  title?: string;
}

/** The sidebar subtitle for one catalog entry (or none, while loading). */
export function endpointLabel(entry: ModelCatalogEntry | undefined): EndpointLabel {
  const baseUrl = entry?.baseUrl?.trim();
  if (!baseUrl) return { text: "모델 정보를 불러오는 중", unreachable: false };

  const host = formatEndpointHost(baseUrl);
  if (entry?.reachable === false) {
    return { text: `${host} 연결할 수 없음`, unreachable: true, title: baseUrl };
  }
  return { text: `${host}에서 실행 중`, unreachable: false, title: baseUrl };
}

/** True for an all-caps alphanumeric quantization/format tag such as "FP8" or "INT4". */
function isFormatTag(token: string): boolean {
  return /^[A-Z0-9]{2,8}$/.test(token) && /\d/.test(token);
}

/**
 * Derive a short, readable label from a raw HF model id — e.g.
 * "huihui-ai/Huihui-Qwen3.8-27B-abliterated" -> "Qwen3.8-27B (abliterated)"
 * "Qwen/Qwen3.8-Flash-Next-FP8" -> "Qwen3.8-Flash-Next FP8"
 * Strips the HF org, drops a leading vendor tag ahead of the "Qwen..." name,
 * then folds a trailing lowercase qualifier into parens or a trailing
 * all-caps format tag into a plain suffix.
 */
export function shortModelName(id: string): string {
  const base = id.split("/").pop() ?? id;
  const parts = base.split("-").filter(Boolean);
  const qwenIndex = parts.findIndex((part) => /^qwen/i.test(part));
  const trimmed = qwenIndex > 0 ? parts.slice(qwenIndex) : parts;
  if (trimmed.length <= 1) return trimmed.join("-") || base;

  const last = trimmed[trimmed.length - 1] ?? "";
  const head = trimmed.slice(0, -1).join("-");
  if (isFormatTag(last)) return `${head} ${last}`;
  if (/^[a-z]+$/.test(last)) return `${head} (${last})`;
  return trimmed.join("-");
}
