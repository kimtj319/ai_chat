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
 * Names a server does not offer are simply absent. The write tools stay off
 * until someone ticks them.
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
  // The same read side under /v1/mcp names (API-token connections land there).
  "fetch",
  "getConfluencePage",
  "getConfluenceSpaces",
  "getPagesInConfluenceSpace",
  "getVisibleJiraProjects",
  "lookupJiraAccountId",
  "searchConfluenceUsingCql",
];

/**
 * Where a request with this credential has to go: /v1/mcp for anything this
 * app can hold. A Basic API-token header gets the same 401 "invalid_token" on
 * /v2/mcp as no header at all, while /v1/mcp accepts it (measured 2026-11-05),
 * and the login in atlassianOAuth.ts issues its token for the /v1/mcp resource.
 * Without a credential the request goes where it was registered.
 */
export function atlassianEndpoint(url: string, credential: string | undefined): string {
  if (!credential || !isAtlassianMcpUrl(url)) return url;
  const parsed = new URL(url);
  if (!/^\/v\d+\/mcp(\/|$)/.test(parsed.pathname)) return url;
  parsed.pathname = "/v1/mcp";
  return parsed.toString();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The Authorization header value, or a Korean reason it cannot be made. */
export function atlassianCredential(email: unknown, token: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const address = typeof email === "string" ? email.trim() : "";
  const secret = typeof token === "string" ? token.trim() : "";
  if (!EMAIL.test(address)) return { ok: false, error: "Atlassian 계정 이메일을 입력해 주세요." };
  if (!secret || /\s/.test(secret)) return { ok: false, error: "Atlassian API 토큰을 입력해 주세요(공백 없이)." };
  return { ok: true, value: `Basic ${Buffer.from(`${address}:${secret}`, "utf8").toString("base64")}` };
}
