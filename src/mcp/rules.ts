// What a registered MCP server has to look like, and which servers each half
// of the 라이브러리 page shows. Pure, like auth/adminRules.ts, and for the same
// reason: these rules decide whose server ends up describing itself inside your
// prompts, so they are worth being readable in one place rather than spread
// across a form and two lists.

import type { McpAuthMode, McpHealthState, McpServerSummary } from "../api/types";

/** Every MCP tool is stored as `mcp__{slug}__{tool}` in `enabledTools`. */
export const MCP_TOOL_PREFIX = "mcp__";

export const NAME_MAX_LENGTH = 40;
export const DESCRIPTION_MAX_LENGTH = 200;
export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 32;

/** Lowercase letters, digits and single hyphens. Underscores are excluded on
 *  purpose: the tool name joins the slug and the tool with `__`, so a slug
 *  carrying one would make the name ambiguous to split. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

export interface McpServerDraft {
  name: string;
  slug: string;
  description: string;
  url: string;
  authMode: McpAuthMode;
  authHeaderName: string;
  credential: string;
}

export type McpDraftField = "name" | "slug" | "description" | "url" | "authHeaderName" | "credential";
export type McpDraftErrors = Partial<Record<McpDraftField, string>>;

/**
 * `hasStoredCredential` is true when the server already holds one for this
 * user, which is what lets an edit leave the credential field blank.
 */
export function validateDraft(draft: McpServerDraft, hasStoredCredential = false): McpDraftErrors {
  const errors: McpDraftErrors = {};

  const name = draft.name.trim();
  if (name.length === 0) errors.name = "이름을 입력해주세요.";
  else if (name.length > NAME_MAX_LENGTH) errors.name = `이름은 ${NAME_MAX_LENGTH}자 이하여야 합니다.`;

  const slug = draft.slug.trim();
  if (slug.length === 0) {
    errors.slug = "슬러그를 입력해주세요.";
  } else if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) {
    errors.slug = `슬러그는 영문 소문자·숫자·하이픈으로 ${SLUG_MIN_LENGTH}~${SLUG_MAX_LENGTH}자여야 합니다.`;
  }

  // Required, not optional: this is the line another user reads before ticking
  // the box, and a blank one tells them nothing about what they are taking on.
  const description = draft.description.trim();
  if (description.length === 0) errors.description = "설명을 입력해주세요. 다른 사용자는 이 설명을 보고 채택 여부를 판단합니다.";
  else if (description.length > DESCRIPTION_MAX_LENGTH) errors.description = `설명은 ${DESCRIPTION_MAX_LENGTH}자 이하여야 합니다.`;

  const url = draft.url.trim();
  if (url.length === 0) {
    errors.url = "주소를 입력해주세요.";
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    // https only: the credential and every argument a tool is called with
    // travel over this connection.
    if (!parsed) errors.url = "올바른 URL이 아닙니다.";
    else if (parsed.protocol !== "https:") errors.url = "주소는 https:// 로 시작해야 합니다.";
  }

  if (draft.authMode === "header") {
    const header = draft.authHeaderName.trim();
    if (header.length === 0) errors.authHeaderName = "헤더 이름을 입력해주세요 (예: Authorization).";
    else if (!HEADER_NAME_PATTERN.test(header)) errors.authHeaderName = "헤더 이름에는 영문·숫자·하이픈만 쓸 수 있습니다.";

    if (draft.credential.trim().length === 0 && !hasStoredCredential) {
      errors.credential = "이 인증 방식에는 자격 증명이 필요합니다.";
    }
  }

  return errors;
}

export function hasErrors(errors: McpDraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** The host requests actually go to. Falls back to the raw string so a URL the
 *  browser cannot parse is still shown rather than hidden. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The tool's own name, without the `mcp__{slug}__` the stored name carries. */
export function shortToolName(fullName: string): string {
  const parts = fullName.split("__");
  return parts.length > 2 ? parts.slice(2).join("__") : fullName;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * The picker owns only the MCP half of `enabledTools`; 도구 설정 owns the
 * builtin half. Composing the array at save time from whatever is stored right
 * now — rather than saving a copy taken when the picker opened — is what keeps
 * the two views from overwriting each other's side of the same array.
 */
export function mergeMcpSelection(current: string[], mcpSelected: string[]): string[] {
  return [...current.filter((name) => !isMcpToolName(name)), ...mcpSelected];
}

/** Order-insensitive: the two views build the array in different orders. */
export function sameTools(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

export type SelectionState = "none" | "some" | "all";

export function selectionState(toolNames: string[], enabled: ReadonlySet<string>): SelectionState {
  if (toolNames.length === 0) return "none";
  const on = toolNames.filter((name) => enabled.has(name)).length;
  if (on === 0) return "none";
  return on === toolNames.length ? "all" : "some";
}

/**
 * Membership in "내 라이브러리": the builtins, everything this user registered
 * themselves, and everything they adopted. Not gated on `hidden` — a card the
 * user switched off has to stay in this list, with its switch showing off, or
 * there would be no way back on except leaving the page. This is what decides
 * which cards LibraryPage draws, not what the model may call; for that, see
 * `isMcpVisible` below.
 */
export function myLibrary(servers: McpServerSummary[], adopted: string[], meId: string): McpServerSummary[] {
  const adoptedIds = new Set(adopted);
  return servers.filter(
    (server) => server.origin === "builtin" || server.createdBy === meId || adoptedIds.has(server.id),
  );
}

/**
 * THE FINAL RULE — kept as one function so the picker and the "which tools
 * does the model get" question can never quietly diverge again: a server used
 * to be visible here (createdBy === me) while un-adopting it silently dropped
 * its tools server-side. Must read exactly like
 * server/mcp/ownerPrefs.ts `effectiveServers`; server/mcp/rulesParity.test.ts
 * imports both and runs the same input matrix against them, failing if they
 * ever answer differently.
 */
export function isMcpVisible(
  server: Pick<McpServerSummary, "id" | "origin" | "createdBy" | "status">,
  adopted: string[],
  hidden: string[],
  meId: string,
): boolean {
  if (server.status !== "active") return false;
  if (hidden.includes(server.id)) return false;
  return server.origin === "builtin" || server.createdBy === meId || adopted.includes(server.id);
}

/** What the picker shows and what the model may call — `isMcpVisible` applied
 *  to the whole registry. */
export function visibleLibrary(
  servers: McpServerSummary[],
  adopted: string[],
  hidden: string[],
  meId: string,
): McpServerSummary[] {
  return servers.filter((server) => isMcpVisible(server, adopted, hidden, meId));
}

/** The shared section: everything someone else registered, adopted or not. */
export function sharedByOthers(servers: McpServerSummary[], meId: string): McpServerSummary[] {
  return servers.filter((server) => server.origin === "user" && server.createdBy !== meId);
}

export const HEALTH_LABELS: Record<McpHealthState, string> = {
  unknown: "확인 전",
  ok: "정상",
  degraded: "불안정",
  down: "연결 실패",
  quarantined: "차단됨",
};

/** A state this client does not know is shown verbatim rather than hidden. */
export function healthLabel(state: string): string {
  return HEALTH_LABELS[state as McpHealthState] ?? state;
}

export function healthIsBad(state: string): boolean {
  return state === "degraded" || state === "down" || state === "quarantined";
}

export const AUTH_MODE_LABELS: Record<McpAuthMode, string> = {
  none: "인증 없음",
  header: "헤더 인증",
};
