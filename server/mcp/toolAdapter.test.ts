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
import { definitionsFor, mcpToolName, sanitizeInputSchema } from "./toolAdapter.js";
import type { McpServerRecord } from "../types.js";

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

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
