// Atlassian 로그인(OAuth): 가짜 인증 서버로 등록·PKCE·주소 붙여넣기·갱신·로그아웃. `npx tsx server/routes/mcp.atlassianOAuth.test.ts`
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atlassian-oauth-test-"));

const { mcpRouter } = await import("./mcp.js");
const { createServer, setServerStatus, deleteServer } = await import("../mcp/registryStore.js");
const { readOwnerPrefs, getCredential, setCredential, setOAuthSession, forgetServerEverywhere } = await import("../mcp/ownerPrefs.js");
const { configureAtlassianOAuthForTests, ATLASSIAN_REDIRECT_URI, ATLASSIAN_OAUTH_RESOURCE } = await import("../mcp/atlassianOAuth.js");
const { atlassianEndpoint } = await import("../mcp/atlassian.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------- 가짜 Atlassian 인증 서버 */
const seen = { registrations: 0, tokenRequests: [] as Record<string, string>[], challenge: "" };
let refreshDelayMs = 0;
let refreshFails = false;
let issued = 0;
const auth = express();
auth.use(express.json());
auth.use(express.urlencoded({ extended: false }));
auth.post("/v1/register", (req, res) => {
  seen.registrations++;
  res.json({ client_id: "client-1", redirect_uris: req.body.redirect_uris });
});
auth.post("/v1/token", async (req, res) => {
  seen.tokenRequests.push(req.body);
  if (req.body.grant_type === "authorization_code") {
    const expected = crypto.createHash("sha256").update(String(req.body.code_verifier)).digest("base64url");
    if (req.body.code !== "good-code" || expected !== seen.challenge) return res.status(400).json({ error: "invalid_grant" });
    issued++;
    return res.json({ access_token: `acc-${issued}`, refresh_token: `ref-${issued}`, expires_in: 3600 });
  }
  if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs));
  if (refreshFails) return res.status(400).json({ error: "invalid_grant", error_description: "refresh token expired" });
  issued++;
  res.json({ access_token: `acc-${issued}`, refresh_token: `ref-${issued}`, expires_in: 3600 });
});
const authListener = auth.listen(0, "127.0.0.1");
await new Promise((r) => authListener.once("listening", r));
configureAtlassianOAuthForTests({ authBase: `http://127.0.0.1:${(authListener.address() as AddressInfo).port}` });

/* ----------------------------------------------------------- 웹 앱 라우트 */
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "bob");
  req.ownerId = who;
  req.user = { id: who, role: "user" } as never;
  next();
});
app.use("/api", mcpRouter);
const listener = app.listen(0, "127.0.0.1");
await new Promise((r) => listener.once("listening", r));
const port = (listener.address() as AddressInfo).port;
async function call(as: string, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { "x-as": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

console.log("server/mcp/atlassianOAuth.ts + ownerPrefs + routes — Atlassian 로그인");

async function makeServer(slug: string, url = "https://mcp.atlassian.com/v2/mcp") {
  const made = await createServer({ name: slug, slug, description: "검사용", url, authMode: "header", authHeaderName: "Authorization", createdBy: "bob", origin: "user" });
  if (!made.ok) throw new Error("setup failed");
  await setServerStatus(made.server.id, true, "system"); // 네트워크 새로고침을 끈다
  return made.server.id;
}
const id = await makeServer("atlassian");

/* ---------------------------------------------------------- 로그인 시작 */
const started = await call("bob", "POST", `/mcp/servers/${id}/atlassian/login`);
const authorize = new URL(started.json?.url ?? "http://x/");
seen.challenge = authorize.searchParams.get("code_challenge") ?? "";
check("승인 주소를 돌려준다(PKCE S256, /v1/mcp 자원, 127.0.0.1 콜백)",
  started.status === 200 && authorize.pathname === "/v1/authorize" && authorize.searchParams.get("code_challenge_method") === "S256"
    && authorize.searchParams.get("resource") === ATLASSIAN_OAUTH_RESOURCE && authorize.searchParams.get("redirect_uri") === ATLASSIAN_REDIRECT_URI
    && authorize.searchParams.get("client_id") === "client-1", JSON.stringify(started.json));
const state = authorize.searchParams.get("state") ?? "";
await call("bob", "POST", `/mcp/servers/${id}/atlassian/login`);
check("클라이언트 등록은 한 번만(파일에 남겨 다시 쓴다)", seen.registrations === 1, String(seen.registrations));

const plain = await makeServer("plain", "https://example.com/mcp");
const notAtl = await call("bob", "POST", `/mcp/servers/${plain}/atlassian/login`);
check("Atlassian 이 아닌 커넥터는 400", notAtl.status === 400);

/* ---------------------------------------------------------- 로그인 마치기 */
const callback = `${ATLASSIAN_REDIRECT_URI}?code=good-code&state=${state}`;
const otherOwner = await call("carol", "POST", `/mcp/servers/${id}/atlassian/login/finish`, { url: callback });
check("다른 사람이 시작한 로그인은 마칠 수 없다(400)", otherOwner.status === 400, JSON.stringify(otherOwner.json));
const garbage = await call("bob", "POST", `/mcp/servers/${id}/atlassian/login/finish`, { url: "그냥 글자" });
check("주소가 아니면 400 과 안내", garbage.status === 400 && /주소/.test(garbage.json?.error ?? ""), JSON.stringify(garbage.json));
const denied = await call("bob", "POST", `/mcp/servers/${id}/atlassian/login/finish`, { url: `${ATLASSIAN_REDIRECT_URI}?error=access_denied&state=${state}` });
check("승인을 거절한 주소면 400", denied.status === 400 && /거절/.test(denied.json?.error ?? ""));

const finished = await call("bob", "POST", `/mcp/servers/${id}/atlassian/login/finish`, { url: callback });
const prefs = await readOwnerPrefs("bob");
check("로그인하면 Bearer 로 저장하고 갱신 정보를 함께 둔다",
  finished.status === 200 && prefs.credentials[id] === "Bearer acc-1" && prefs.oauth?.[id]?.refreshToken === "ref-1" && prefs.oauth?.[id]?.clientId === "client-1",
  `${finished.status} ${JSON.stringify(finished.json)}`);
const tokenReq = seen.tokenRequests.at(-1) ?? {};
check("토큰 교환에 code_verifier·같은 redirect_uri·/v1/mcp 자원을 보낸다",
  Boolean(tokenReq.code_verifier) && tokenReq.redirect_uri === ATLASSIAN_REDIRECT_URI && tokenReq.resource === ATLASSIAN_OAUTH_RESOURCE);
const reused = await call("bob", "POST", `/mcp/servers/${id}/atlassian/login/finish`, { url: callback });
check("같은 state 는 두 번 쓸 수 없다", reused.status === 400);

const list = await call("bob", "GET", "/mcp/servers");
const summary = list.json?.servers?.find((s: { id: string }) => s.id === id);
check("요약: 로그인 상태(oauth)·키 있음, 토큰 값은 응답에 없다",
  summary?.atlassianAuth === "oauth" && summary?.hasCredential === true && !JSON.stringify(list.json).includes("acc-1") && !JSON.stringify(list.json).includes("ref-1"));

/* ------------------------------------------------------------- 자동 갱신 */
check("만료 전이면 저장된 값을 그대로", (await getCredential("bob", id)) === "Bearer acc-1");
await setOAuthSession("bob", id, { accessToken: "acc-old", refreshToken: "ref-old", expiresAt: Date.now() + 30_000, clientId: "client-1" });
refreshDelayMs = 150;
const before = seen.tokenRequests.length;
const [a, b] = await Promise.all([getCredential("bob", id), getCredential("bob", id)]);
refreshDelayMs = 0;
const after = await readOwnerPrefs("bob");
check("만료가 가까우면 갱신하고, 동시에 불러도 한 번만", a === b && a?.startsWith("Bearer acc-") && a !== "Bearer acc-old" && seen.tokenRequests.length - before === 1,
  `${a} ${b} ${seen.tokenRequests.length - before}`);
check("새 refresh token 으로 바꿔 저장", after.oauth?.[id]?.refreshToken !== "ref-old" && after.credentials[id] === a);

await setOAuthSession("bob", id, { accessToken: "acc-stale", refreshToken: "ref-dead", expiresAt: Date.now() - 1000, clientId: "client-1" });
refreshFails = true;
const stale = await getCredential("bob", id);
refreshFails = false;
check("갱신이 실패하면 이전 값을 돌려준다(호출이 401 로 다시 로그인을 알린다)", stale === "Bearer acc-stale", String(stale));

/* --------------------------------------------- API 토큰·로그아웃·삭제 */
await setCredential("bob", id, `Basic ${Buffer.from("bob@example.com:tok").toString("base64")}`);
const tokenPrefs = await readOwnerPrefs("bob");
const asToken = (await call("bob", "GET", "/mcp/servers")).json?.servers?.find((s: { id: string }) => s.id === id);
check("API 토큰을 저장하면 로그인 정보는 지워지고 token 으로 보인다", !tokenPrefs.oauth?.[id] && asToken?.atlassianAuth === "token", `${JSON.stringify(tokenPrefs.oauth)} ${asToken?.atlassianAuth} ${tokenPrefs.credentials[id]?.slice(0, 6)}`);

await setOAuthSession("bob", id, { accessToken: "acc-x", refreshToken: "ref-x", expiresAt: Date.now() + 3_600_000, clientId: "client-1" });
const logout = await call("bob", "PUT", `/mcp/servers/${id}/credential`, { credential: null });
const loggedOut = await readOwnerPrefs("bob");
check("로그아웃(키 삭제)은 토큰과 갱신 정보를 모두 지운다", logout.status === 200 && !loggedOut.credentials[id] && !loggedOut.oauth?.[id]);

const second = await makeServer("atlassian-2");
await setOAuthSession("bob", id, { accessToken: "acc-1a", refreshToken: "ref-1a", expiresAt: null, clientId: "client-1" });
await setOAuthSession("bob", second, { accessToken: "acc-2a", refreshToken: "ref-2a", expiresAt: null, clientId: "client-1" });
await deleteServer(second);
await forgetServerEverywhere(second);
const kept = await readOwnerPrefs("bob");
check("커넥터를 지우면 그 로그인만 지우고 다른 커넥터 로그인은 남는다", !kept.oauth?.[second] && kept.oauth?.[id]?.refreshToken === "ref-1a" && !kept.credentials[second]);

/* ------------------------------------------------------- 보내는 주소 */
check("로그인 토큰(Bearer)도 /v1/mcp 로 보낸다", atlassianEndpoint("https://mcp.atlassian.com/v2/mcp", "Bearer acc") === "https://mcp.atlassian.com/v1/mcp");

listener.close();
authListener.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
