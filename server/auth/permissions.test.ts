// 그룹별 권한 검사. `npm test` 로 돈다.
//
// 확인하려는 것:
//   1. 공용 자원 계정: 관리자, 그리고 이름이 PRIVILEGED_GROUPS(기본 "AI Product")인 그룹의 구성원.
//   2. 개인 키: 저장·끝 네 자리만 공개·삭제, 잘못된 값 거절, 남의 키는 안 보인다.
//   3. 웹 검색 키: 본인 키 > (공용 자원 계정만) 공용 키 > 없음 — 없으면 등록하라는 오류.
//   4. wisenut 이슈·Alpha Vantage: 호출마다 본인 키를 싣고, 공용 자원 계정만 공용 키로 대신한다.
//   5. 모델: 기본(VLLM_ENDPOINTS) 모델은 모두, 화면에서 등록한 모델은 등록한 사람과 공용 자원
//      계정만 보고·고르고·쓴다. 지우기도 그 둘만.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-permissions-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "wise|http://mock-env/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
process.env.REASONING_PROFILES = "";
process.env.MODEL_ADMIN_TOKEN = "";
process.env.TAVILY_API_KEY = "shared-tavily-key";
process.env.TAVILY_API_URL = "http://mock-tavily/search";
process.env.GITLAB_MCP_URL = "http://mock-gitlab/mcp";
process.env.GITLAB_TOKEN = "shared-gitlab-token";
process.env.ALPHAVANTAGE_API_KEY = "shared-av-key";
delete process.env.PRIVILEGED_GROUPS;

const { isPrivilegedUser, privilegedGroupNames, shareBaseUrlFor } = await import("./privilege.js");
const { createUser, setUserGroup, getUser } = await import("../storage/userStore.js");
const { createGroup } = await import("../storage/groupStore.js");
const { getPersonalKey, setPersonalKey } = await import("../storage/personalKeys.js");
const { meRouter } = await import("../routes/me.js");
const { modelsRouter } = await import("../routes/models.js");
const { conversationsRouter } = await import("../routes/conversations.js");
const { webSearchTool, tavilyKeyFor } = await import("../tools/webSearch.js");
const { callUrlFor } = await import("../mcp/toolAdapter.js");
const { resolveModel } = await import("../vllm/client.js");
const { modelAccessForOwner, modelIsForbidden } = await import("../vllm/access.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("server/auth/privilege.ts + storage/personalKeys.ts + routes/me.ts + 웹 검색·이슈·모델 권한");

/* ---------------------------------------------------------------- 가짜 서버들 */

let tavilyAuth: string | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("http://mock-tavily")) {
    tavilyAuth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ answer: "a", results: [] }));
  }
  if (url === "http://mock-env/v1/models") return new Response(JSON.stringify({ object: "list", data: [{ id: "wise-model", max_model_len: 1000 }] }));
  if (url === "http://mock-bob/v1/models") return new Response(JSON.stringify({ object: "list", data: [{ id: "bob-model", max_model_len: 1000 }] }));
  return realFetch(input, init);
}) as typeof fetch;

/* ---------------------------------------------------------------- 계정 */

for (const id of ["admin1", "aip1", "bob", "carol", "nogroup"]) {
  await createUser({ id, name: id, email: `${id}@example.com`, password: "password-1234", status: "active", role: id === "admin1" ? "admin" : "user" });
}
const aip = await createGroup("  ai product ", "admin1");
const other = await createGroup("S&P", "admin1");
if (!aip.ok || !other.ok) throw new Error("group setup failed");
await setUserGroup("aip1", aip.group.id);
await setUserGroup("bob", other.group.id);
await setUserGroup("carol", other.group.id);

/* ---------------------------------------------------------------- 1. 공용 자원 계정 */

check("기본 그룹 이름은 AI Product", JSON.stringify(privilegedGroupNames()) === JSON.stringify(["ai product"]));
check("관리자는 그룹 없이도 공용 자원 계정", await isPrivilegedUser(await getUser("admin1")));
check("AI Product 구성원(대소문자·공백 무시)", await isPrivilegedUser(await getUser("aip1")));
check("다른 그룹 구성원은 아니다", !(await isPrivilegedUser(await getUser("bob"))));
check("그룹 없는 일반 계정은 아니다", !(await isPrivilegedUser(await getUser("nogroup"))));
process.env.PRIVILEGED_GROUPS = "S&P, AI Platform";
check("PRIVILEGED_GROUPS 로 바꿀 수 있다", await isPrivilegedUser(await getUser("bob")));
check("…그러면 AI Product 는 빠진다", !(await isPrivilegedUser(await getUser("aip1"))));
delete process.env.PRIVILEGED_GROUPS;

/* ---------------------------------------------------------------- 1-1. 공유 링크 주소 */

delete process.env.SHARE_BASE_URL;
check("SHARE_BASE_URL 이 없으면 누구도 바꾸지 않는다", (await shareBaseUrlFor(await getUser("bob"))) === undefined);
process.env.SHARE_BASE_URL = "http://server.example:9000/";
check("AI Product 구성원이 아니면 서버 주소로 공유한다", (await shareBaseUrlFor(await getUser("bob"))) === "http://server.example:9000");
check("그룹 없는 계정도 서버 주소", (await shareBaseUrlFor(await getUser("nogroup"))) === "http://server.example:9000");
check("관리자라도 AI Product 구성원이 아니면 서버 주소", (await shareBaseUrlFor(await getUser("admin1"))) === "http://server.example:9000");
check("AI Product 구성원은 지금 주소 그대로", (await shareBaseUrlFor(await getUser("aip1"))) === undefined);
process.env.SHARE_BASE_URL = "server.example:9000";
check("http(s) 주소가 아니면 쓰지 않는다", (await shareBaseUrlFor(await getUser("bob"))) === undefined);
delete process.env.SHARE_BASE_URL;

/* ---------------------------------------------------------------- 준비: 앱 */

const app = express();
app.use(express.json());
app.use(async (req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "bob");
  req.ownerId = who;
  req.user = (await getUser(who)) ?? undefined;
  next();
});
app.use("/api", meRouter);
app.use("/api", modelsRouter);
app.use("/api", conversationsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

async function call(as: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await realFetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { "x-as": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, json, text };
}

/* ---------------------------------------------------------------- 2. 개인 키 */

{
  const before = await call("carol", "GET", "/me/access");
  check("내 권한을 알려 준다", before.status === 200 && before.json.privileged === false && before.json.keys.tavily.set === false);
  check("AI Product 는 privileged", (await call("aip1", "GET", "/me/access")).json.privileged === true);
  const put = await call("carol", "PUT", "/me/keys/tavily", { value: "  tvly-carol-own-key-9876  " });
  check("키를 저장하면 끝 네 자리만 돌려준다", put.status === 200 && put.json.keys.tavily.set && put.json.keys.tavily.hint === "…9876");
  check("…응답에 키 값은 없다", !put.text.includes("tvly-carol-own-key"));
  check("…앞뒤 공백은 걷는다", (await getPersonalKey("carol", "tavily")) === "tvly-carol-own-key-9876");
  check("다른 계정에는 안 보인다", (await call("bob", "GET", "/me/access")).json.keys.tavily.set === false);
  check("짧은 값은 400", (await call("carol", "PUT", "/me/keys/gitlab", { value: "abc" })).status === 400);
  check("공백 든 값은 400", (await call("carol", "PUT", "/me/keys/gitlab", { value: "abc def ghi jkl" })).status === 400);
  check("모르는 키 이름은 404", (await call("carol", "PUT", "/me/keys/openai", { value: "abcdefghijkl" })).status === 404);
  const del = await call("carol", "DELETE", "/me/keys/tavily");
  check("삭제된다", del.status === 200 && del.json.keys.tavily.set === false && (await getPersonalKey("carol", "tavily")) === null);
}

/* ---------------------------------------------------------------- 3. 웹 검색 키 */

{
  const ctx = (ownerId: string) => ({ ownerId, conversationId: "c1" });
  check("일반 계정·개인 키 없음 → 키 없음", (await tavilyKeyFor(ctx("bob"))) === null);
  check("AI Product·개인 키 없음 → 공용 키", (await tavilyKeyFor(ctx("aip1"))) === "shared-tavily-key");
  check("관리자 → 공용 키", (await tavilyKeyFor(ctx("admin1"))) === "shared-tavily-key");
  check("계정을 모르는 호출 → 공용 키", (await tavilyKeyFor(undefined)) === "shared-tavily-key");
  await setPersonalKey("bob", "tavily", "tvly-bob-own-key-1111");
  await setPersonalKey("aip1", "tavily", "tvly-aip-own-key-2222");
  check("일반 계정·개인 키 → 개인 키", (await tavilyKeyFor(ctx("bob"))) === "tvly-bob-own-key-1111");
  check("AI Product 도 개인 키가 먼저", (await tavilyKeyFor(ctx("aip1"))) === "tvly-aip-own-key-2222");

  let refused = "";
  try {
    await webSearchTool.execute({ query: "날씨" }, ctx("carol"));
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  check("개인 키 없는 일반 계정은 등록하라는 오류", refused.includes("설정 › 개인 키"), refused);
  check("…공용 키로 나가지 않았다", tavilyAuth === null);
  await webSearchTool.execute({ query: "날씨" }, ctx("bob"));
  check("개인 키로 검색한다", tavilyAuth === "Bearer tvly-bob-own-key-1111", String(tavilyAuth));
}

/* ---------------------------------------------------------------- 4. wisenut 이슈 */

{
  const gitlab = { origin: "builtin", slug: "gitlab", url: "http://mock-gitlab/mcp?token=shared-gitlab-token" } as never;
  const otherServer = { origin: "builtin", slug: "deepwiki", url: "http://deepwiki/mcp" } as never;
  check("다른 서버는 주소 그대로", (await callUrlFor(otherServer, "carol")) === "http://deepwiki/mcp");
  let error: Error | null = null;
  try {
    await callUrlFor(gitlab, "carol");
  } catch (err) {
    error = err as Error;
  }
  check("토큰 없는 일반 계정은 도구 결과로 거절", error?.name === "McpToolReportedError" && error.message.includes("[API 키 미등록]") && error.message.includes("GitLab"), String(error));
  check("AI Product 는 공용 토큰 + 묻는 계정 아이디(내 이슈용)", (await callUrlFor(gitlab, "aip1")) === "http://mock-gitlab/mcp?token=shared-gitlab-token&me=aip1");
  await setPersonalKey("carol", "gitlab", "glpat-carol/own+token");
  check("개인 토큰을 실어 보낸다(URL 인코딩)", (await callUrlFor(gitlab, "carol")) === "http://mock-gitlab/mcp?token=glpat-carol%2Fown%2Btoken&me=carol");
  await setPersonalKey("carol", "gitlab", "glpat-second-project-token", "다른 프로젝트");
  check(
    "GitLab 토큰을 여러 개 두면 모두 싣는다",
    (await callUrlFor(gitlab, "carol")) === "http://mock-gitlab/mcp?token=glpat-carol%2Fown%2Btoken&token=glpat-second-project-token&me=carol",
  );
  let dup = "";
  try {
    await setPersonalKey("carol", "gitlab", "glpat-second-project-token");
  } catch (err) {
    dup = (err as Error).message;
  }
  check("같은 토큰은 두 번 넣지 않는다", dup.includes("이미"), dup);
  const summary = (await call("carol", "GET", "/me/access")).json.keys.gitlab;
  check("토큰마다 이름·끝 네 자리가 보이고 값은 없다", summary.items?.length === 2 && summary.items[1].label === "다른 프로젝트" && summary.items[1].hint === "…oken" && !JSON.stringify(summary).includes("glpat"), JSON.stringify(summary));
  const removed = await call("carol", "DELETE", `/me/keys/gitlab/${summary.items[0].id}`);
  check("하나만 지울 수 있다", removed.status === 200 && removed.json.keys.gitlab.items.length === 1);
  check("…남은 토큰만 싣는다", (await callUrlFor(gitlab, "carol")) === "http://mock-gitlab/mcp?token=glpat-second-project-token&me=carol");

  const av = { origin: "builtin", slug: "alphavantage", url: "https://mcp.alphavantage.co/mcp?apikey=shared-av-key" } as never;
  let avError: Error | null = null;
  try {
    await callUrlFor(av, "bob");
  } catch (err) {
    avError = err as Error;
  }
  check("Alpha Vantage: 키 없는 일반 계정은 거절", avError?.name === "McpToolReportedError" && avError.message.includes("Alpha Vantage"), String(avError));
  check("Alpha Vantage: AI Product 는 공용 키", (await callUrlFor(av, "aip1")) === "https://mcp.alphavantage.co/mcp?apikey=shared-av-key");
  await setPersonalKey("bob", "alphavantage", "BOBAVKEY1234");
  check("Alpha Vantage: 개인 키를 실어 보낸다", (await callUrlFor(av, "bob")) === "https://mcp.alphavantage.co/mcp?apikey=BOBAVKEY1234");
  check("사용자가 만든 같은 slug 서버는 건드리지 않는다", (await callUrlFor({ origin: "user", slug: "alphavantage", url: "https://x/mcp" } as never, "bob")) === "https://x/mcp");
}

/* ---------------------------------------------------------------- 5. 모델 */

{
  const added = await call("bob", "POST", "/models/endpoints", { baseUrl: "http://mock-bob/v1", label: "bob 서버" });
  check("일반 계정도 모델 서버를 등록한다", added.status === 201, added.text);

  const ids = async (as: string) => ((await call(as, "GET", "/models")).json.models as string[]).sort().join(",");
  check("등록한 사람은 기본+자기 모델", (await ids("bob")) === "bob-model,wise-model", await ids("bob"));
  check("AI Product 는 전부", (await ids("aip1")) === "bob-model,wise-model");
  check("관리자도 전부", (await ids("admin1")) === "bob-model,wise-model");
  check("다른 일반 계정은 기본 모델만", (await ids("carol")) === "wise-model", await ids("carol"));
  check("…current 도 쓸 수 있는 모델", (await call("carol", "GET", "/models")).json.current === "wise-model");

  const endpointsCarol = (await call("carol", "GET", "/models/endpoints")).json;
  check("엔드포인트 목록도 걸러진다", endpointsCarol.endpoints.length === 1 && endpointsCarol.privileged === false);
  const endpointsBob = (await call("bob", "GET", "/models/endpoints")).json.endpoints as Array<{ baseUrl: string; mine: boolean; deletable: boolean }>;
  const bobRow = endpointsBob.find((e) => e.baseUrl === "http://mock-bob/v1");
  check("…자기 것은 mine·deletable", bobRow?.mine === true && bobRow.deletable === true);
  check("…기본 모델은 지울 수 없다", endpointsBob.find((e) => e.baseUrl === "http://mock-env/v1")?.deletable === false);

  const carolAccess = await modelAccessForOwner("carol");
  check("허용되지 않은 모델을 고르는 것은 금지", await modelIsForbidden(carolAccess, "bob-model"));
  check("목록에 없는 id 는 금지가 아니다(나중에 대체)", !(await modelIsForbidden(carolAccess, "gone-model")));
  check("질문할 때는 쓸 수 있는 모델로 대체", (await resolveModel("bob-model", carolAccess.allows)).model === "wise-model");
  check("등록한 사람은 그대로 쓴다", (await resolveModel("bob-model", (await modelAccessForOwner("bob")).allows)).model === "bob-model");

  check("대화를 그 모델로 만들 수 없다(403)", (await call("carol", "POST", "/conversations", { model: "bob-model" })).status === 403);
  check("등록한 사람은 만들 수 있다", (await call("bob", "POST", "/conversations", { model: "bob-model" })).status === 201);
  const conv = await call("carol", "POST", "/conversations", { model: "wise-model" });
  check("기본 모델 대화는 만든다", conv.status === 201);
  check("대화 모델을 바꿀 수도 없다(403)", (await call("carol", "PATCH", `/conversations/${conv.json.id}`, { model: "bob-model" })).status === 403);

  check("남이 등록한 서버는 지울 수 없다", (await call("carol", "DELETE", "/models/endpoints", { baseUrl: "http://mock-bob/v1" })).status === 403);
  check("등록한 사람은 지운다", (await call("bob", "DELETE", "/models/endpoints", { baseUrl: "http://mock-bob/v1" })).status === 204);
  check("…등록자 기록도 지운다", !fs.readFileSync(path.join(dataDir, "model-owners.json"), "utf8").includes("mock-bob"));

  await call("bob", "POST", "/models/endpoints", { baseUrl: "http://mock-bob/v1" });
  check("AI Product 는 남의 서버도 지운다", (await call("aip1", "DELETE", "/models/endpoints", { baseUrl: "http://mock-bob/v1" })).status === 204);
}

server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
