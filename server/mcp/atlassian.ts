/**
 * Atlassian's remote MCP server (mcp.atlassian.com) takes an API token as HTTP
 * Basic auth: "Authorization: Basic base64(email:api_token)". Asking people to
 * build that by hand is how the first registration ended up sending a bare
 * token, which the server rejected on every call with "The session token is
 * missing the scope claim" (2026-11-04). So the connector forms ask for the
 * email and the token, and the header value is made here.
 */

const ATLASSIAN_MCP_HOST = "mcp.atlassian.com";

export function isAtlassianMcpUrl(url: string): boolean {
  try {
    return new URL(url).host.toLowerCase() === ATLASSIAN_MCP_HOST;
  } catch {
    return false;
  }
}

/**
 * Checked by default when nobody has chosen: the read side of Jira and
 * Confluence plus what it needs to run (discover → executeRead, the site id).
 * About 20KB of schema against 70KB for all 26; the write tools stay off until
 * someone ticks them.
 */
export const ATLASSIAN_RECOMMENDED_TOOLS: readonly string[] = [
  "atlassianUserInfo",
  "discover",
  "executeRead",
  "getAccessibleAtlassianResources",
  "getConfluenceContent",
  "getJiraIssue",
  "listJiraIssueComments",
  "search",
  "searchConfluence",
  "searchJiraIssuesUsingJql",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The Authorization header value, or a Korean reason it cannot be made. */
export function atlassianCredential(email: unknown, token: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const address = typeof email === "string" ? email.trim() : "";
  const secret = typeof token === "string" ? token.trim() : "";
  if (!EMAIL.test(address)) return { ok: false, error: "Atlassian 계정 이메일을 입력해 주세요." };
  if (!secret || /\s/.test(secret)) return { ok: false, error: "Atlassian API 토큰을 입력해 주세요(공백 없이)." };
  return { ok: true, value: `Basic ${Buffer.from(`${address}:${secret}`, "utf8").toString("base64")}` };
}
