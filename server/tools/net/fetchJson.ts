import { config } from "../../config.js";

/**
 * For a tool that makes two sequential calls (search then summary, geocode then
 * forecast): both share the tool's runner budget, so each leg gets 60% of the
 * single-request timeout (6s at the default) — enough for a slow leg, short
 * enough that one cannot eat the whole budget and leave nothing for the other.
 */
export const LEG_TIMEOUT_MS = Math.round(config.toolHttpTimeoutMs * 0.6);

export interface FetchJsonOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  /** The message when fetch itself throws. `detail` is the error's own message. */
  failed: (detail: string, err: unknown) => string;
  /** The message for a non-2xx answer. */
  status: (status: number) => string;
}

/**
 * GET a keyless JSON API. Each tool passes its own messages, because those are
 * what the model reads and they name the service and the step that failed.
 */
export async function fetchJsonOrThrow<T>(url: string | URL, options: FetchJsonOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...(options.headers ? { headers: options.headers } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    throw new Error(options.failed(err instanceof Error ? err.message : String(err), err));
  }
  if (!res.ok) throw new Error(options.status(res.status));
  return (await res.json()) as T;
}
