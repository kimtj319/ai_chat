import { errorMessage } from "../state/friendlyError";
import { apiPath } from "./base";

export class ApiError extends Error {}

/**
 * Every /api route except the auth ones answers 401 once the session is gone
 * (expired, logged out elsewhere, the account blocked mid-session). The app
 * shell registers a handler here so any such answer — from a plain request, an
 * upload, or the message stream — sends the user back to the login screen
 * instead of leaving a half-broken view behind.
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

/** The parts of a refusal body the helpers read. Each field is null when absent. */
export interface ErrorBody {
  error: string | null;
  message: string | null;
  code: string | null;
  adoptedCount: number | null;
}

/**
 * Read a refusal's JSON body. Each caller keeps its own fallback text and error
 * class: the strings must stay as they are, because friendlyError.ts matches on them.
 */
export async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed = (await response.json()) as {
      error?: string;
      message?: string;
      code?: string;
      adoptedCount?: number;
    } | null;
    return {
      error: parsed?.error ?? null,
      message: parsed?.message ?? null,
      code: parsed?.code ?? null,
      adoptedCount: typeof parsed?.adoptedCount === "number" ? parsed.adoptedCount : null,
    };
  } catch {
    // Response body was not JSON (or already consumed) — the caller falls back
    // to the status line.
    return { error: null, message: null, code: null, adoptedCount: null };
  }
}

export async function extractErrorMessage(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  const body = await readErrorBody(response);
  const message = body.error ?? body.message;
  if (message) return `${message} (${status})`;
  return `요청이 실패했습니다 (${status})`;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiPath(path), {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch (error) {
    throw new ApiError(`서버에 연결할 수 없습니다: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new ApiError(await extractErrorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
