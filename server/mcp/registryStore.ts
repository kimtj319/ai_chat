import fs from "node:fs/promises";
import crypto from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "../storage/atomic.js";
import { mcpSeedMarkerFile, mcpServerFile, mcpServersDir } from "../storage/paths.js";
import { withLock } from "../storage/mutex.js";
import { config } from "../config.js";
import type { McpAuthMode, McpServerRecord } from "../types.js";

/**
 * The MCP registry on disk: ONE JSON FILE PER SERVER at
 * {DATA_DIR}/mcp/servers/{id}.json, written with the same atomic
 * temp-file+rename discipline as accounts and groups (storage/groupStore.ts).
 *
 * The registry is GLOBAL and readable by every signed-in account, which is why
 * it holds no secret of any kind. A credential belongs to the owner who entered
 * it and lives in their own file (mcp/ownerPrefs.ts).
 *
 * Uniqueness (name, slug) is enforced under ONE lock for the whole collection,
 * for the reason groupStore.ts states: per-id locking cannot make a name unique
 * across ids.
 */

const LOCK = "mcp-servers";

export const MAX_NAME_CHARS = 40;
/**
 * The description is REQUIRED and short: it is the one sentence a person reads
 * before ticking "adopt", and an empty one leaves them deciding blind.
 */
export const MAX_DESCRIPTION_CHARS = 200;
export const MIN_SLUG_CHARS = 2;
export const MAX_SLUG_CHARS = 32;
/**
 * Lowercase alphanumerics in hyphen-separated groups. NO UNDERSCORES, and that
 * is the whole point: the tool name is `mcp__{slug}__{tool}` with a DOUBLE
 * UNDERSCORE as the separator, so a slug containing one would make the boundary
 * ambiguous. Hyphens are safe because the function-name charset vLLM accepts
 * ([A-Za-z0-9_-]) includes them.
 *
 * At 32 characters a slug now eats half of the 64-character name budget, which
 * is why toolAdapter.ts drops (and logs) an over-long tool rather than
 * truncating it — that limit does real work here.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Ids we mint ourselves, so this only has to reject anything else. */
const ID_PATTERN = /^[a-z0-9]{8,32}$/;

/** Under TOOL_TIMEOUT_MS at the top, and above "instantly fails" at the bottom. */
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 9000;

export function normalizeServerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return ID_PATTERN.test(id) ? id : null;
}

export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_NAME_CHARS ? name : null;
}

/**
 * The slug is IMMUTABLE once written: it is inside the tool name the model sees
 * (`mcp__{slug}__{tool}`), and conversations have stored those names in their
 * tool calls. Renaming it would silently rewrite what those transcripts say
 * happened.
 */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase();
  if (slug.length < MIN_SLUG_CHARS || slug.length > MAX_SLUG_CHARS) return null;
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/** Required. Null means "not a usable description", which is a 400, not a blank. */
export function normalizeDescription(raw: unknown): string | null {
  const text = normalizeOptionalText(raw, MAX_DESCRIPTION_CHARS);
  return text ? text : null;
}

/**
 * The same cleaning without the "must be present" rule, for the admin's
 * optional disable reason. Returns null only when the value is unusable.
 */
export function normalizeOptionalText(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return text.length <= max ? text : null;
}

export function clampTimeoutMs(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return Math.min(Math.max(config.mcpTimeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  return Math.min(Math.max(Math.trunc(parsed), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export function normalizeAuthMode(raw: unknown): McpAuthMode | null {
  return raw === "none" || raw === "header" ? raw : null;
}

/**
 * An HTTP header name, per RFC 7230 token rules. Anything else could inject a
 * second header into the request we build.
 */
export function normalizeHeaderName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(name) ? name : null;
}

export async function getServer(id: string): Promise<McpServerRecord | null> {
  const normalized = normalizeServerId(id);
  if (!normalized) return null;
  try {
    return await readJsonFile<McpServerRecord>(mcpServerFile(normalized));
  } catch (err) {
    console.warn(`[mcp] corrupt server file for "${normalized}":`, err);
    return null;
  }
}

/** Every registered server, name-sorted. A corrupt file is skipped, not fatal. */
export async function listServers(): Promise<McpServerRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(mcpServersDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const servers: McpServerRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
    const server = await getServer(entry.slice(0, -".json".length));
    if (server) servers.push(server);
  }
  servers.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return servers;
}

export interface CreateServerInput {
  name: string;
  slug: string;
  description: string;
  url: string;
  authMode: McpAuthMode;
  authHeaderName?: string;
  toolAllowlist?: string[];
  /** Builtin definitions only — see McpServerRecord.sendUserIdentity. */
  sendUserIdentity?: boolean;
  timeoutMs?: number;
  origin?: McpServerRecord["origin"];
  createdBy: string;
}

export type CreateServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; code: "duplicate_name" | "duplicate_slug" };

export async function createServer(input: CreateServerInput): Promise<CreateServerResult> {
  return withLock(LOCK, async () => {
    const existing = await listServers();
    if (existing.some((s) => s.name === input.name)) return { ok: false as const, code: "duplicate_name" as const };
    if (existing.some((s) => s.slug === input.slug)) return { ok: false as const, code: "duplicate_slug" as const };
    const now = new Date().toISOString();
    const server: McpServerRecord = {
      id: crypto.randomBytes(6).toString("hex"),
      name: input.name,
      slug: input.slug,
      description: input.description,
      transport: "http",
      url: input.url,
      origin: input.origin ?? "user",
      status: "active",
      authMode: input.authMode,
      ...(input.authMode === "header" && input.authHeaderName ? { authHeaderName: input.authHeaderName } : {}),
      ...(input.toolAllowlist?.length ? { toolAllowlist: input.toolAllowlist } : {}),
      ...(input.sendUserIdentity ? { sendUserIdentity: true } : {}),
      timeoutMs: clampTimeoutMs(input.timeoutMs),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonFileAtomic(mcpServerFile(server.id), server);
    return { ok: true as const, server };
  });
}

/** Everything PATCH may change. `slug` is absent on purpose — it is immutable. */
export interface UpdateServerInput {
  name?: string;
  description?: string;
  url?: string;
  authMode?: McpAuthMode;
  authHeaderName?: string | null;
  timeoutMs?: number;
  /** Not reachable from PATCH: the route builds its patch field by field. */
  toolAllowlist?: string[];
  /** Not reachable from PATCH either, and for a stronger reason — see McpServerRecord.sendUserIdentity. */
  sendUserIdentity?: boolean;
  /**
   * Also not reachable from PATCH: only seeding sets it, to adopt a record that
   * predates its builtin definition. `origin` decides whether a server is on by
   * default or has to be adopted one owner at a time, so it is the difference
   * between shipping a feature and shipping a switch nobody finds.
   */
  origin?: McpServerRecord["origin"];
}

export type UpdateServerResult =
  | { ok: true; server: McpServerRecord }
  | { ok: false; code: "not_found" | "duplicate_name" };

export async function updateServer(id: string, patch: UpdateServerInput): Promise<UpdateServerResult> {
  const normalized = normalizeServerId(id);
  if (!normalized) return { ok: false as const, code: "not_found" as const };
  return withLock(LOCK, async () => {
    const existing = await listServers();
    const target = existing.find((s) => s.id === normalized);
    if (!target) return { ok: false as const, code: "not_found" as const };
    if (patch.name !== undefined && existing.some((s) => s.id !== normalized && s.name === patch.name)) {
      return { ok: false as const, code: "duplicate_name" as const };
    }
    const updated: McpServerRecord = {
      ...target,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.origin !== undefined ? { origin: patch.origin } : {}),
      ...(patch.authMode !== undefined ? { authMode: patch.authMode } : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutMs: clampTimeoutMs(patch.timeoutMs) } : {}),
      updatedAt: new Date().toISOString(),
    };
    // Empty means "every tool", which is the absence of the field rather than
    // an empty list — an empty list stored would read as "no tools at all".
    if (patch.toolAllowlist !== undefined) {
      if (patch.toolAllowlist.length > 0) updated.toolAllowlist = patch.toolAllowlist;
      else delete updated.toolAllowlist;
    }
    // Same shape, and the false case must REMOVE it: this is the switch that
    // decides whether every user's name leaves the building, so a record the
    // code no longer vouches for has to stop vouching.
    if (patch.sendUserIdentity !== undefined) {
      if (patch.sendUserIdentity) updated.sendUserIdentity = true;
      else delete updated.sendUserIdentity;
    }
    // authHeaderName only means something in "header" mode; leaving a stale one
    // behind after a switch to "none" would put it back on the next switch.
    const mode = updated.authMode;
    if (mode === "none") {
      delete updated.authHeaderName;
    } else if (patch.authHeaderName !== undefined) {
      if (patch.authHeaderName === null) delete updated.authHeaderName;
      else updated.authHeaderName = patch.authHeaderName;
    }
    await writeJsonFileAtomic(mcpServerFile(normalized), updated);
    return { ok: true as const, server: updated };
  });
}

/** Admin disable/enable. A disabled server contributes no tools to anyone. */
export async function setServerStatus(
  id: string,
  disabled: boolean,
  by: string,
  reason?: string,
): Promise<McpServerRecord | null> {
  const normalized = normalizeServerId(id);
  if (!normalized) return null;
  return withLock(LOCK, async () => {
    const target = await getServer(normalized);
    if (!target) return null;
    const now = new Date().toISOString();
    const updated: McpServerRecord = disabled
      ? {
          ...target,
          status: "disabled",
          disabledBy: by,
          disabledAt: now,
          ...(reason ? { disabledReason: reason } : {}),
          updatedAt: now,
        }
      : { ...target, status: "active", updatedAt: now };
    if (!disabled) {
      delete updated.disabledBy;
      delete updated.disabledAt;
      delete updated.disabledReason;
    }
    await writeJsonFileAtomic(mcpServerFile(normalized), updated);
    return updated;
  });
}

export async function deleteServer(id: string): Promise<boolean> {
  const normalized = normalizeServerId(id);
  if (!normalized) return false;
  return withLock(LOCK, async () => {
    try {
      await fs.unlink(mcpServerFile(normalized));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

/**
 * Builtin servers, seeded into DATA_DIR at boot.
 *
 * The same reasoning as {DATA_DIR}/.model (vllm/endpoints.ts): a list baked
 * into the image cannot be edited on the deployment, because only data/ and
 * log/ are bind-mounted. Seeding writes ordinary registry records that an admin
 * can then disable, edit, or delete like any other — and the marker file
 * records which slugs were ever seeded, so a builtin somebody deleted stays
 * deleted instead of reappearing at the next restart.
 *
 * deepwiki is the one default because it is the endpoint this integration was
 * verified against, it needs no credential, and a feature whose server list
 * starts empty is a feature nobody switches on.
 */
const BUILTIN_SERVERS: Array<Omit<CreateServerInput, "createdBy">> = [
  {
    name: "DeepWiki",
    slug: "deepwiki",
    description:
      "GitHub 저장소의 문서를 읽고 질문에 답하는 공개 MCP 서버입니다. 저장소 구조 확인, 문서 열람, 자연어 질의를 지원합니다.",
    url: "https://mcp.deepwiki.com/mcp",
    authMode: "none",
    origin: "builtin",
  },
  {
    name: "Context7",
    slug: "context7",
    description:
      "라이브러리와 프레임워크의 최신 공식 문서를 조회하는 공개 MCP 서버입니다. 라이브러리를 먼저 식별한 뒤 그 문서에서 질문에 답합니다.",
    url: "https://mcp.context7.com/mcp",
    authMode: "none",
    origin: "builtin",
  },
  {
    name: "Microsoft Learn",
    slug: "microsoft-learn",
    description:
      "Microsoft 공식 기술 문서와 코드 예제를 검색하고 원문을 가져오는 공개 MCP 서버입니다. Azure, .NET, Windows 문서를 다룹니다.",
    url: "https://learn.microsoft.com/api/mcp",
    authMode: "none",
    origin: "builtin",
  },
  // Alpha Vantage authenticates with a query parameter and accepts no auth
  // header, so its key is part of the URL — routes/mcp.ts is what keeps that
  // query from reaching a client. Without a key there is no entry at all: a
  // builtin that answers every call with "invalid API key" sits in everyone's
  // library looking like a broken feature.
  ...(config.alphavantageApiKey
    ? [
        {
          name: "Alpha Vantage",
          slug: "alphavantage",
          description:
            "주식 시세·시계열·재무제표·실적·배당·뉴스·환율을 조회하는 금융 데이터 MCP 서버입니다. 미국 시장이 중심이며, 종목 검색과 시장 개장 여부 확인도 지원합니다.",
          url: `https://mcp.alphavantage.co/mcp?apikey=${config.alphavantageApiKey}`,
          authMode: "none" as const,
          origin: "builtin" as const,
          // It offers 133 tools; these are the ones worth a place in every
          // prompt of every turn.
          // Measured against toolAdapter's 8 KB per-server schema budget: all
          // sixteen candidates come to 11,089 bytes, and the budget drops the
          // overflow in ALPHABETICAL order, which silently cost the weekly and
          // monthly series. These eleven come to 7,676, so the cut is made here
          // on usefulness instead. Left out: TIME_SERIES_INTRADAY (1,272 — the
          // most expensive and the least asked for), TOP_GAINERS_LOSERS, and
          // the three full statements (INCOME_STATEMENT, BALANCE_SHEET,
          // CASH_FLOW, 1,707 together), whose headline figures COMPANY_OVERVIEW
          // already carries. Adding one back means taking one out.
          toolAllowlist: [
            "SYMBOL_SEARCH",
            "GLOBAL_QUOTE",
            "MARKET_STATUS",
            "TIME_SERIES_DAILY",
            "TIME_SERIES_WEEKLY",
            "TIME_SERIES_MONTHLY",
            "COMPANY_OVERVIEW",
            "EARNINGS",
            "DIVIDENDS",
            "NEWS_SENTIMENT",
            "CURRENCY_EXCHANGE_RATE",
          ],
        },
      ]
    : []),
  // The RAG server is ours, runs beside the app, and is the one server here
  // that is told who is asking (sendUserIdentity) — which is why its address
  // comes from .env and its definition from code rather than from a form.
  ...(config.ragMcpUrl
    ? [
        {
          name: "사내 문서 검색",
          slug: "sf1rag",
          description:
            "사내 문서를 의미 기반으로 검색해 근거 단락을 돌려주는 RAG 서버입니다. 검색·원문 확대·컬렉션 목록을 지원하며, 각자 볼 수 있는 문서만 검색됩니다.",
          url: config.ragMcpUrl,
          authMode: "none" as const,
          origin: "builtin" as const,
          sendUserIdentity: true,
        },
      ]
    : []),
  // GitLab, for reading the SF-1 issue tracker. Both halves are required: the
  // endpoint, and the token that is appended to it here. The token is not on
  // that server — it travels in the URL and is forwarded to GitLab — so the
  // pair is what makes the server usable, and the absence of either would seed
  // an entry whose every call answers "no token".
  //
  // sendUserIdentity is deliberately absent: the token is one project-scoped
  // bot, so every account sees the same issues and there is nothing for a name
  // to change. Sending one would be telling a server something it cannot use.
  ...(config.gitlabMcpUrl && config.gitlabToken
    ? [
        {
          name: "SF-1 이슈",
          slug: "gitlab",
          description:
            "GitLab 의 SF-1 v7 이슈를 읽습니다. 제목·본문 부분일치 검색, 라벨·상태별 목록, 이슈 본문과 댓글 조회를 지원합니다. 읽기 전용입니다.",
          url: `${config.gitlabMcpUrl}?token=${encodeURIComponent(config.gitlabToken)}`,
          authMode: "none" as const,
          origin: "builtin" as const,
        },
      ]
    : []),
];

export async function seedBuiltinServers(): Promise<void> {
  let seeded: string[] = [];
  try {
    seeded = (await readJsonFile<string[]>(mcpSeedMarkerFile())) ?? [];
  } catch (err) {
    console.warn("[mcp] could not read the seed marker; not seeding to avoid re-creating deleted builtins:", err);
    return;
  }
  const existing = await listServers();
  const added: string[] = [];
  const realigned: string[] = [];
  for (const builtin of BUILTIN_SERVERS) {
    const present = existing.find((s) => s.slug === builtin.slug || s.name === builtin.name);
    if (present) {
      // A builtin is defined in code and .env, so the record follows them and
      // not the other way round. Seeding runs once, so without this an edited
      // allowlist or a rotated key would change nothing until someone deleted
      // the record by hand — and the symptom (a tool quietly missing) gives no
      // hint of the cause.
      const sameTools =
        JSON.stringify(present.toolAllowlist ?? []) === JSON.stringify(builtin.toolAllowlist ?? []);
      const sameIdentity = Boolean(present.sendUserIdentity) === Boolean(builtin.sendUserIdentity);
      // A record created through the route before the builtin existed is
      // origin:"user", which means every owner has to adopt it by hand — half a
      // builtin, and the half nobody sees. Adopting it here is what makes the
      // definition in code actually govern the record.
      const sameOrigin = present.origin === (builtin.origin ?? "user");
      if (present.url !== builtin.url || !sameTools || !sameIdentity || !sameOrigin) {
        const patched = await updateServer(present.id, {
          url: builtin.url,
          toolAllowlist: builtin.toolAllowlist ?? [],
          sendUserIdentity: Boolean(builtin.sendUserIdentity),
          ...(builtin.origin ? { origin: builtin.origin } : {}),
        });
        if (patched.ok) realigned.push(builtin.slug);
      }
      if (!seeded.includes(builtin.slug)) seeded.push(builtin.slug);
      continue;
    }
    // Absent but already marked: someone deleted it on purpose. Leave it gone.
    if (seeded.includes(builtin.slug)) continue;
    const created = await createServer({ ...builtin, createdBy: "system" });
    if (created.ok) {
      seeded.push(builtin.slug);
      added.push(`${builtin.name} (${builtin.slug})`);
    } else {
      console.warn(`[mcp] could not seed builtin "${builtin.slug}": ${created.code}`);
    }
  }
  if (realigned.length > 0) {
    console.log(`[mcp] realigned builtin server(s) with the code definition: ${realigned.join(", ")}`);
  }
  if (added.length > 0) {
    await writeJsonFileAtomic(mcpSeedMarkerFile(), seeded);
    console.log(`[mcp] seeded builtin server(s): ${added.join(", ")}`);
  } else if (seeded.length > 0) {
    await writeJsonFileAtomic(mcpSeedMarkerFile(), seeded);
  }
}
