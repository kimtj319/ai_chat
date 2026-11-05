// Atlassian 커넥터: 이메일+API 토큰 → Basic 인증, 도구 고르기(권장 기본값). `npx tsx server/routes/mcp.atlassian.test.ts`
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atlassian-test-"));

const { mcpRouter } = await import("./mcp.js");
const { createServer, setServerStatus, listServers } = await import("../mcp/registryStore.js");
const { readOwnerPrefs } = await import("../mcp/ownerPrefs.js");
const { atlassianCredential, atlassianEndpoint, ATLASSIAN_RECOMMENDED_TOOLS } = await import("../mcp/atlassian.js");
const { definitionsFor } = await import("../mcp/toolAdapter.js");

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

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "bob");
  req.ownerId = who;
  req.user = { id: who, role: who === "admin" ? "admin" : "user" } as never;
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

console.log("server/mcp/atlassian.ts + routes/mcp.ts — Atlassian 커넥터");

/* ------------------------------------------------------ Basic 인증 만들기 */
{
  const made = atlassianCredential("kim@example.com", "ATATT3xToken");
  check("이메일:토큰을 base64 로 묶은 Basic 값", made.ok && made.value === `Basic ${Buffer.from("kim@example.com:ATATT3xToken").toString("base64")}`, JSON.stringify(made));
  check("이메일이 아니면 거절", !atlassianCredential("kim", "tok").ok);
  check("토큰이 비었거나 공백이 섞이면 거절", !atlassianCredential("kim@example.com", "").ok && !atlassianCredential("kim@example.com", "a b").ok);
}

/* ------------------------------------- API 토큰(Basic)은 /v1/mcp 로 보낸다 */
{
  const basic = `Basic ${Buffer.from("kim@example.com:tok").toString("base64")}`;
  check("Basic 이면 /v2/mcp 를 /v1/mcp 로", atlassianEndpoint("https://mcp.atlassian.com/v2/mcp", basic) === "https://mcp.atlassian.com/v1/mcp");
  check("Basic 이면 /v1/mcp 는 그대로", atlassianEndpoint("https://mcp.atlassian.com/v1/mcp", basic) === "https://mcp.atlassian.com/v1/mcp");
  check("Bearer(Atlassian 로그인 토큰)도 /v1/mcp 로", atlassianEndpoint("https://mcp.atlassian.com/v2/mcp", "Bearer abc") === "https://mcp.atlassian.com/v1/mcp");
  check("키가 없으면 그대로", atlassianEndpoint("https://mcp.atlassian.com/v2/mcp", undefined) === "https://mcp.atlassian.com/v2/mcp");
  check("다른 서버는 Basic 이어도 그대로", atlassianEndpoint("https://example.com/v2/mcp", basic) === "https://example.com/v2/mcp");
}

const created = await createServer({
  name: "Atlassian",
  slug: "atlassian",
  description: "검사용",
  url: "https://mcp.atlassian.com/v2/mcp",
  authMode: "header",
  authHeaderName: "Authorization",
  createdBy: "bob",
  origin: "user",
});
if (!created.ok) throw new Error("setup failed");
const id = created.server.id;
// 네트워크로 새로고침하지 않게 꺼 둔다 — 여기서 보는 것은 라우트 계약이다.
await setServerStatus(id, true, "system");

/* -------------------------------------------- 개인 키(이메일 + API 토큰) */
{
  const res = await call("carol", "PUT", `/mcp/servers/${id}/credential`, { credential: "ATATT3xCarol", atlassianEmail: "carol@example.com" });
  const stored = (await readOwnerPrefs("carol")).credentials[id];
  check("이메일과 토큰을 주면 Basic 값으로 저장한다", res.status === 200 && stored === `Basic ${Buffer.from("carol@example.com:ATATT3xCarol").toString("base64")}`, `${res.status} ${stored}`);
  const bad = await call("carol", "PUT", `/mcp/servers/${id}/credential`, { credential: "tok", atlassianEmail: "not-an-email" });
  check("이메일 형식이 틀리면 400", bad.status === 400 && /이메일/.test(bad.json?.error ?? ""), JSON.stringify(bad.json));
}

/* ------------------------------------------------------------ 도구 고르기 */
{
  const denied = await call("carol", "PATCH", `/mcp/servers/${id}`, { toolSelection: ["search"] });
  check("등록한 사람이 아니면 도구를 고를 수 없다(403)", denied.status === 403, String(denied.status));
  const ok = await call("bob", "PATCH", `/mcp/servers/${id}`, { toolSelection: ["search", "getJiraIssue"] });
  const record = (await listServers()).find((s) => s.id === id)!;
  check("등록한 사람은 고른 도구를 저장한다", ok.status === 200 && JSON.stringify(record.toolSelection) === '["search","getJiraIssue"]', JSON.stringify(record.toolSelection));
  check("요약에 고른 것인지 표시", ok.json?.server?.toolSelectionCustom === true && ok.json?.server?.atlassian === true, JSON.stringify(ok.json?.server));
  const reset = await call("bob", "PATCH", `/mcp/servers/${id}`, { toolSelection: null });
  const after = (await listServers()).find((s) => s.id === id)!;
  check("null 이면 권장 기본값으로 돌아간다", reset.status === 200 && after.toolSelection === undefined && reset.json?.server?.toolSelectionCustom === false);
  const invalid = await call("bob", "PATCH", `/mcp/servers/${id}`, { toolSelection: "search" });
  check("목록이 아니면 400", invalid.status === 400);
}

/* --------------------------------------- 프롬프트에 넘기는 도구(기본값) */
{
  // 실제 Atlassian 서버처럼 26개, 도구마다 설명이 긴 것(합계 약 70KB).
  const names = [
    "addGraphContext", "addOrEditJiraIssueComment", "atlassianUserInfo", "createConfluenceContent", "createJiraIssue", "discover",
    "editJiraIssue", "executeDestructive", "executeRead", "executeWrite", "getAccessibleAtlassianResources", "getCollaborators",
    "getConfluenceContent", "getGraphContext", "getGraphObject", "getJiraIssue", "getLoomObjectsContent", "getPeopleInfo",
    "getWorkActivity", "getWorkPortfolio", "listJiraIssueComments", "search", "searchConfluence", "searchJiraIssuesUsingJql",
    "transitionJiraIssue", "updateConfluenceContent",
  ];
  const tools = names.map((name, i) => ({
    name,
    description: `${name} — ${"설명 ".repeat(200 + (i % 5) * 60)}`,
    inputSchema: { type: "object", properties: { cloudId: { type: "string", description: "사이트 id" } } },
  }));
  const server = (await listServers()).find((s) => s.id === id)!;
  const out = definitionsFor(server, tools as never, "bob");
  const offered = out.definitions.map((d) => d.name.split("__").pop()).sort();
  check("고른 적이 없으면 서버에 있는 권장 도구 10개가 모두 넘어간다", JSON.stringify(offered) === JSON.stringify(ATLASSIAN_RECOMMENDED_TOOLS.filter((n) => names.includes(n)).sort()) && offered.length === 10, JSON.stringify(offered));
  check("쓰기 도구는 기본으로 넘기지 않는다", !offered.some((n) => /^(create|edit|update|transition|executeWrite|executeDestructive)/.test(n!)));
  check("화면에는 26개 모두 보이고 권장·선택 표시가 붙는다", out.choices.length === 26 && out.choices.filter((c) => c.recommended).length === 10 && out.choices.filter((c) => c.selected).length === 10);

  const chosen = definitionsFor({ ...server, toolSelection: ["createJiraIssue", "search"] }, tools as never, "bob");
  check("고른 도구만 넘어간다", JSON.stringify(chosen.definitions.map((d) => d.name.split("__").pop()).sort()) === '["createJiraIssue","search"]');

  const plain = definitionsFor({ ...server, url: "https://example.com/mcp" }, tools as never, "bob");
  const bytes = Buffer.byteLength(JSON.stringify(plain.definitions.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }))), "utf8");
  check("다른 서버는 예전처럼 8KB 한도 안에서 앞에서부터", plain.definitions.length < 10 && bytes <= 8 * 1024, `${plain.definitions.length}개 ${bytes}B`);
}

listener.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
