import crypto from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../storage/atomic.js";
import { mcpDir } from "../storage/paths.js";
import { withLock } from "../storage/mutex.js";

/**
 * Atlassian login for the Atlassian connector (OAuth 2.1: dynamic client
 * registration + PKCE + refresh), the way the meeting-summary page connects.
 *
 * Why not the API token: the organisation has not allowed API-token access to
 * the Rovo MCP server, so every tool call made with one comes back "You don't
 * have permission to connect via API token" (measured 2026-11-05). A person's
 * own login needs no admin step.
 *
 * Why the redirect goes to a loopback address nobody listens on: sending the
 * browser back to this web app's own address needs the organisation admin to
 * allow that domain (Rovo MCP domain settings). Landing on 127.0.0.1 is allowed
 * without it; the page fails to load, but its address bar holds code+state, and
 * the person pastes that address back. Same flow the meeting-summary page uses.
 *
 * This module only talks HTTP and keeps the short-lived login attempts in
 * memory. Where the resulting tokens live is ownerPrefs.ts (mcp.json, the one
 * file that holds credentials).
 */

const AUTH_BASE = "https://mcp.atlassian.com";
/** The token is issued for this resource, so requests carrying it must go here. */
export const ATLASSIAN_OAUTH_RESOURCE = "https://mcp.atlassian.com/v1/mcp";
export const ATLASSIAN_REDIRECT_URI = "http://127.0.0.1:33418/atlassian/callback";
const PENDING_TTL_MS = 15 * 60 * 1000;
const HTTP_TIMEOUT_MS = 20_000;

let fetchImpl: typeof fetch = (...args) => fetch(...args);
let authBase = AUTH_BASE;

/** Tests point this at a local fake of the Atlassian authorization server. */
export function configureAtlassianOAuthForTests(options: { fetch?: typeof fetch; authBase?: string }): void {
  if (options.fetch) fetchImpl = options.fetch;
  if (options.authBase) authBase = options.authBase;
}

export class AtlassianOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AtlassianTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  clientId: string;
}

interface PendingLogin {
  ownerId: string;
  serverId: string;
  verifier: string;
  clientId: string;
  at: number;
}

const pending = new Map<string, PendingLogin>();

const b64url = (buf: Buffer): string => buf.toString("base64url");

function clientFile(): string {
  return path.join(mcpDir(), "atlassian-oauth-client.json");
}

async function postForJson(url: string, body: string, contentType: string, what: string): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": contentType, Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const reason = String(parsed.error_description ?? parsed.error ?? parsed.raw ?? "");
    throw new AtlassianOAuthError(`Atlassian ${what}에 실패했습니다(HTTP ${res.status}) ${reason}`.trim(), 502);
  }
  return parsed;
}

/**
 * One registered client for the whole app (it names no user), kept under
 * DATA_DIR so a restart does not register a new one each time.
 */
async function clientId(): Promise<string> {
  return withLock("atlassian-oauth-client", async () => {
    const saved = await readJsonFile<{ clientId?: string; redirectUri?: string }>(clientFile()).catch(() => null);
    if (saved?.clientId && saved.redirectUri === ATLASSIAN_REDIRECT_URI) return saved.clientId;
    const body = await postForJson(
      `${authBase}/v1/register`,
      JSON.stringify({
        client_name: "AI Console",
        redirect_uris: [ATLASSIAN_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      "application/json",
      "클라이언트 등록",
    );
    const id = typeof body.client_id === "string" ? body.client_id : "";
    if (!id) throw new AtlassianOAuthError("Atlassian 클라이언트 등록 응답에 client_id 가 없습니다.", 502);
    await writeJsonFileAtomic(clientFile(), { clientId: id, redirectUri: ATLASSIAN_REDIRECT_URI });
    return id;
  });
}

/** The Atlassian consent page for this owner and server. */
export async function startAtlassianLogin(ownerId: string, serverId: string, now = Date.now()): Promise<string> {
  const id = await clientId();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  for (const [key, value] of pending) if (now - value.at > PENDING_TTL_MS) pending.delete(key);
  pending.set(state, { ownerId, serverId, verifier, clientId: id, at: now });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: ATLASSIAN_REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: ATLASSIAN_OAUTH_RESOURCE,
  });
  return `${authBase}/v1/authorize?${query}`;
}

function tokensFrom(body: Record<string, unknown>, id: string, previousRefresh: string | undefined, now: number): AtlassianTokens {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previousRefresh ?? "";
  if (!accessToken) throw new AtlassianOAuthError("Atlassian 토큰 응답에 access_token 이 없습니다.", 502);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  return { accessToken, refreshToken, expiresAt: expiresIn ? now + expiresIn * 1000 : null, clientId: id };
}

/**
 * The address the browser ended up on after "Accept" (pasted back by the
 * person). The state must be one this same owner started for this server.
 */
export async function finishAtlassianLogin(
  ownerId: string,
  serverId: string,
  pastedUrl: unknown,
  now = Date.now(),
): Promise<AtlassianTokens> {
  let url: URL;
  try {
    url = new URL(String(pastedUrl ?? "").trim());
  } catch {
    throw new AtlassianOAuthError("주소 형식이 아닙니다. 승인 뒤 이동한 페이지의 주소창 주소 전체를 붙여 넣어 주세요.", 400);
  }
  const denied = url.searchParams.get("error");
  if (denied) {
    throw new AtlassianOAuthError(`Atlassian 에서 승인이 거절되었습니다: ${url.searchParams.get("error_description") ?? denied}`, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new AtlassianOAuthError("주소에 code·state 가 없습니다. '허용'을 누른 뒤 이동한 주소 전체를 붙여 넣어 주세요.", 400);
  }
  const attempt = pending.get(state);
  if (!attempt || attempt.ownerId !== ownerId || attempt.serverId !== serverId || now - attempt.at > PENDING_TTL_MS) {
    throw new AtlassianOAuthError("로그인 요청이 만료되었거나 이 화면에서 시작한 것이 아닙니다. 'Atlassian 로그인'을 다시 눌러 주세요.", 400);
  }
  pending.delete(state);
  const body = await postForJson(
    `${authBase}/v1/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ATLASSIAN_REDIRECT_URI,
      client_id: attempt.clientId,
      code_verifier: attempt.verifier,
      resource: ATLASSIAN_OAUTH_RESOURCE,
    }).toString(),
    "application/x-www-form-urlencoded",
    "토큰 발급",
  );
  return tokensFrom(body, attempt.clientId, undefined, now);
}

/** A new access token (and possibly a rotated refresh token). */
export async function refreshAtlassianTokens(id: string, refreshToken: string, now = Date.now()): Promise<AtlassianTokens> {
  const body = await postForJson(
    `${authBase}/v1/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: id,
      resource: ATLASSIAN_OAUTH_RESOURCE,
    }).toString(),
    "application/x-www-form-urlencoded",
    "토큰 갱신",
  );
  return tokensFrom(body, id, refreshToken, now);
}
