// MCP 도구 어댑터 검사. `npm test` 로 돈다.
//
// 이 파일이 하는 일은 **남의 서버가 준 것을 우리 프롬프트에 담을 수 있는
// 모양으로 줄이는 것**이다. 줄이는 규칙이 틀리면 두 가지로 조용히 망가진다.
//
//   - 너무 헐거우면: 남의 서버가 준 이름·스키마가 그대로 프롬프트에 들어가
//     내장 도구를 가리거나 모델이 못 읽는 함수 이름이 된다
//   - 너무 빡빡하면: 도구가 **말없이 사라진다**. 예산을 넘긴 것은 알파벳 순으로
//     잘려 나가는데, 그러면 "왜 이 도구만 안 보이지" 가 된다
//
// 그래서 여기서 보는 것은 무엇을 남기고 무엇을 버리는지, 그리고 **버린 것을
// 말해 주는지** 다.
//
// config 는 불러들일 때 환경변수를 읽으므로, import 보다 먼저 세워 둔다.
process.env.VLLM_ENDPOINTS = "http://127.0.0.1:8000/v1";
process.env.MCP_ALLOWED_HOSTS = "";
process.env.MCP_ALLOW_HTTP_HOSTS = "";
process.env.MCP_IDENTITY_TOKEN = "";

import type { McpServerRecord } from "../types.js";
const { definitionsFor, mcpToolName } = await import("./toolAdapter.js");
const { sanitizeInputSchema } = await import("./schemaSanitize.js");
const { invalidate, prime, refresh, snapshot } = await import("./discovery.js");
const { assertRegisterableUrl, openSession } = await import("./client.js");

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, message: detail });
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const server = (over: Partial<McpServerRecord> = {}): McpServerRecord =>
  ({
    id: "s1",
    name: "검사용",
    slug: "test",
    description: "검사용 서버",
    transport: "http",
    url: "https://example.com/mcp",
    origin: "builtin",
    status: "active",
    authMode: "none",
    timeoutMs: 8000,
    createdBy: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as McpServerRecord;

const tool = (name: string, description = "설명", schema: unknown = { type: "object", properties: {} }) => ({
  name,
  description,
  inputSchema: schema,
});

console.log("server/mcp/toolAdapter.ts");

/* ------------------------------------------------------------- 이름 짓기 */

{
  check("슬러그와 도구 이름을 두 밑줄로 잇는다", mcpToolName("gitlab", "issues") === "mcp__gitlab__issues");
  check("접두사가 붙는다", mcpToolName("a", "b").startsWith("mcp__"));
}
{
  // 내장 도구와 겹치지 않는다는 것이 접두사의 존재 이유다.
  const builtins = ["web_search", "http_fetch", "calculator", "read_text_file"];
  check("어떤 내장 도구 이름과도 겹치지 않는다", builtins.every((b) => mcpToolName("x", b) !== b));
}

/* --------------------------------------------------- 받을 수 없는 도구 */

{
  const long = "x".repeat(70);
  const out = definitionsFor(server(), [tool(long), tool("ok")], "u1");
  check("이름이 64자를 넘으면 버린다", out.definitions.every((d) => d.name !== mcpToolName("test", long)));
  check("남는 것은 남긴다", out.definitions.some((d) => d.name === "mcp__test__ok"), JSON.stringify(out.definitions.map((d) => d.name)));
  check("버렸다고 말해 준다", out.dropped.some((d) => d.includes("자")), JSON.stringify(out.dropped));
}
{
  // 모델이 부를 수 있는 함수 이름이어야 한다 — 공백·한글·기호가 들어오면
  // 그 이름으로는 호출이 성립하지 않는다.
  const bad = ["도구", "a b", "a.b", "a/b", "a-b!"];
  const out = definitionsFor(server(), bad.map((n) => tool(n)).concat([tool("good_one")]), "u1");
  check("함수 이름이 될 수 없는 것은 버린다", out.definitions.length === 1, JSON.stringify(out.definitions.map((d) => d.name)));
  check("그때도 이유를 남긴다", out.dropped.length === bad.length, JSON.stringify(out.dropped));
}

/* ------------------------------------------------------------ 8KB 예산 */

{
  // 설명이 긴 도구를 잔뜩 준다. 예산을 넘는 순간부터 잘려야 한다.
  const many = Array.from({ length: 40 }, (_, i) =>
    tool(`tool_${String(i).padStart(2, "0")}`, "설".repeat(300)),
  );
  const out = definitionsFor(server(), many, "u1");
  const bytes = out.definitions.reduce(
    (n, d) => n + Buffer.byteLength(JSON.stringify({ name: d.name, description: d.description, parameters: d.parameters }), "utf8"),
    0,
  );
  check("예산(8KB)을 넘지 않는다", bytes <= 8 * 1024, `${bytes}바이트`);
  check("전부 담지는 못한다", out.definitions.length < many.length, `${out.definitions.length}/${many.length}`);
  check("넘친 것을 말해 준다", out.dropped.length > 0 && out.dropped.some((d) => d.includes("예산")), JSON.stringify(out.dropped.slice(0, 2)));
  check("담은 수 + 버린 수 = 준 수", out.definitions.length + out.dropped.length === many.length,
    `${out.definitions.length}+${out.dropped.length} vs ${many.length}`);
}
{
  // 자르는 순서가 알파벳 순이라는 것은 **설계상 알려진 성질**이다. 검사로
  // 박아 두는 이유는, 바뀌면 어떤 도구가 사라지는지가 바뀌기 때문이다.
  const many = Array.from({ length: 30 }, (_, i) => tool(`t${String(i).padStart(2, "0")}`, "설".repeat(300)));
  const out = definitionsFor(server(), [...many].reverse(), "u1");
  const names = out.definitions.map((d) => d.name);
  check("순서를 뒤집어 줘도 같은 것이 남는다(입력 순서에 좌우되지 않는다)",
    names.join(",") === [...names].sort().join(","), names.join(","));
}
{
  const out = definitionsFor(server(), [tool("small")], "u1");
  check("예산 안이면 아무것도 안 버린다", out.dropped.length === 0, JSON.stringify(out.dropped));
}

/* -------------------------------------------------------- 스키마 다듬기 */

{
  const deep = { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } } };
  const clean = JSON.stringify(sanitizeInputSchema(deep));
  // 깊이를 제한하지 않으면 남의 서버가 준 스키마 하나로 프롬프트를 채울 수 있다.
  check("너무 깊은 스키마는 잘린다", !clean.includes('"d"'), clean.slice(0, 160));
}
{
  const wide: { type: string; properties: Record<string, unknown> } = { type: "object", properties: {} };
  for (let i = 0; i < 80; i++) wide.properties[`p${i}`] = { type: "string" };
  const clean = sanitizeInputSchema(wide) as { properties: Record<string, unknown> };
  check("속성 수에 상한이 있다", Object.keys(clean.properties).length <= 40, String(Object.keys(clean.properties).length));
}
{
  for (const junk of [null, undefined, "문자열", 42, [], true]) {
    const clean = sanitizeInputSchema(junk) as { type?: string };
    check(`스키마가 아니어도 객체를 돌려준다: ${JSON.stringify(junk)}`, clean?.type === "object", JSON.stringify(clean));
  }
}

/* ------------------------------------------------- 설명은 그대로 전달된다 */

{
  const out = definitionsFor(server(), [tool("t", "이 도구는 이슈를 찾습니다")], "u1");
  check("설명이 모델에게 그대로 간다", out.definitions[0]?.description.includes("이슈를 찾습니다"), out.definitions[0]?.description);
}
{
  const out = definitionsFor(server(), [tool("t", "설".repeat(3000))], "u1");
  check("너무 긴 설명은 잘린다", (out.definitions[0]?.description.length ?? 0) <= 1024, String(out.definitions[0]?.description.length));
}

/* ------------------------------------------ 호출 실패가 서버 건강에 미치는 것 */

// 남의 서버 대신 fetch 를 바꿔 끼운다. 주소는 공인 IP 그대로 써서 DNS 를 타지 않는다.
const realFetch = globalThis.fetch;
let requested: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** initialize·initialized 는 정상으로 답하고, 나머지는 `reply` 가 정한다. */
function fakeServer(reply: (url: URL, id: unknown, method: string) => Response): void {
  requested = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requested.push(url.href);
    const msg = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method: string };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === "initialize") {
      const custom = reply(url, msg.id, msg.method);
      if (custom.status !== 299) return custom;
      return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "t", version: "1" } } });
    }
    return reply(url, msg.id, msg.method);
  }) as typeof fetch;
}
/** initialize 에서 쓰면 "평소대로 답하라" 는 뜻. */
const PASS = () => new Response(null, { status: 299 });

const remote = (id: string) => server({ id, slug: id, origin: "user", url: "https://93.184.216.34/mcp" });

async function callOnce(record: McpServerRecord): Promise<string | null> {
  const def = definitionsFor(record, [tool("t")], "u1").definitions[0]!;
  try {
    await def.execute({}, { ownerId: "u1", conversationId: "c1" });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

{
  // 모델이 인자를 잘못 넣어 JSON-RPC 오류를 세 번 받았다. 서버는 멀쩡히 답했다 —
  // 이걸 장애로 세면 한 사람의 실수로 모든 계정에서 서버가 30분 사라진다.
  const record = remote("rpcerr");
  prime(record, [tool("t")]);
  fakeServer((_u, id, method) =>
    method === "initialize" ? PASS() : json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } }));
  const messages = [await callOnce(record), await callOnce(record), await callOnce(record)];
  check("JSON-RPC 오류는 모델에게 실패로 돌려준다", messages.every((m) => m?.includes("-32602")), JSON.stringify(messages));
  check("JSON-RPC 오류 세 번으로 서버를 차단하지 않는다", !snapshot(record.id).quarantined, JSON.stringify(snapshot(record.id).health));
  check("JSON-RPC 오류는 건강 상태를 건드리지 않는다", snapshot(record.id).health.state === "ok", JSON.stringify(snapshot(record.id).health));
}
{
  // 한 계정의 틀린 자격 증명(401/403)도 그 계정의 문제다.
  for (const status of [401, 403]) {
    const record = remote(`auth${status}`);
    prime(record, [tool("t")]);
    fakeServer(() => json({ error: "nope" }, status));
    for (let i = 0; i < 3; i++) await callOnce(record);
    check(`HTTP ${status} 세 번으로 서버를 차단하지 않는다`, !snapshot(record.id).quarantined, JSON.stringify(snapshot(record.id).health));
  }
}
{
  // 진짜 장애는 여전히 센다.
  const record = remote("down500");
  prime(record, [tool("t")]);
  fakeServer(() => json({ error: "boom" }, 500));
  for (let i = 0; i < 3; i++) await callOnce(record);
  check("HTTP 500 세 번이면 차단한다", snapshot(record.id).quarantined, JSON.stringify(snapshot(record.id).health));
}
{
  const record = remote("recover");
  prime(record, [tool("t")]);
  fakeServer(() => json({ error: "boom" }, 500));
  await callOnce(record);
  check("한 번 실패하면 down 이다", snapshot(record.id).health.state === "down", JSON.stringify(snapshot(record.id).health));
  fakeServer((_u, id, method) =>
    method === "initialize" ? PASS() : json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } }));
  check("성공하면 결과를 돌려준다", (await callOnce(record)) === null);
  check("성공하면 상태도 ok 로 돌아온다", snapshot(record.id).health.state === "ok", JSON.stringify(snapshot(record.id).health));
}

/* ---------------------------------------------- 다른 출처로 가는 리다이렉트 */

{
  // 리다이렉트를 따라가면 같은 헤더(소유자 자격 증명 포함)를 새 주소로 다시 보낸다.
  // 다른 출처로는 따라가지 않아야 자격 증명이 그쪽으로 새지 않는다.
  fakeServer((url) =>
    url.hostname === "93.184.216.34" ? new Response(null, { status: 307, headers: { location: "https://93.184.216.35/steal" } }) : PASS());
  let error = "";
  try {
    await openSession({ url: "https://93.184.216.34/mcp", authHeaderName: "X-Key", credential: "secret" }, AbortSignal.timeout(5000));
  } catch (err) {
    error = (err as Error).message;
  }
  check("다른 출처로의 리다이렉트는 거절한다", error.includes("리다이렉트"), error);
  check("다른 출처에는 아무것도 보내지 않는다", requested.every((u) => new URL(u).hostname === "93.184.216.34"), JSON.stringify(requested));
}
{
  // 같은 출처 안의 리다이렉트는 그대로 따라간다.
  fakeServer((url) => (url.pathname === "/mcp" ? new Response(null, { status: 307, headers: { location: "/mcp2" } }) : PASS()));
  let error = "";
  try {
    await openSession({ url: "https://93.184.216.34/mcp" }, AbortSignal.timeout(5000));
  } catch (err) {
    error = (err as Error).message;
  }
  check("같은 출처 리다이렉트는 따라간다", error === "" && requested.some((u) => u.endsWith("/mcp2")), `${error} ${JSON.stringify(requested)}`);
}

/* ------------------------------------------- 무효화 뒤에 끝난 옛 탐색 */

{
  // 주소를 고쳐 invalidate() 했는데, 그 전에 시작한 탐색이 옛 서버의 답을 뒤늦게
  // 캐시에 써 넣으면 안 된다.
  const record = remote("stale");
  fakeServer((_u, id, method) =>
    method === "initialize"
      ? PASS()
      : json({ jsonrpc: "2.0", id, result: { tools: [{ name: "old_tool", inputSchema: { type: "object" } }] } }));
  const inner = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await new Promise((r) => setTimeout(r, 30));
    return inner(...args);
  }) as typeof fetch;
  const pending = refresh(record);
  invalidate(record.id);
  await pending;
  check("무효화 뒤에 끝난 탐색은 캐시에 쓰지 않는다", snapshot(record.id).health.state === "unknown", JSON.stringify(snapshot(record.id)));
}

globalThis.fetch = realFetch;

/* ------------------------------------------------- 모델 서버는 주소로 가른다 */

{
  // 모델 서버(127.0.0.1)와 같은 곳을 가리키는 다른 이름. 이름만 비교하면 지나간다.
  let error = "";
  try {
    await assertRegisterableUrl("https://localhost/mcp");
  } catch (err) {
    error = (err as Error).message;
  }
  check("모델 서버로 풀리는 이름은 모델 서버로 거절한다", error.includes("모델 서버"), error);
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
