// 턴 도구 묶음(buildTurnTools)의 MCP 쪽 규칙. `npm test` 로 돈다.
import type { ToolDefinition } from "../tools/types.js";
import { buildTurnTools } from "./turnTools.js";

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

const mcpTool = (name: string) =>
  ({ name, description: name, category: "mcp:x", parameters: { type: "object", properties: {} }, execute: async () => "" }) as unknown as ToolDefinition;
// mcpToolsForOwner 가 주는 것 = 커넥터에서 스위치를 켠 서버의 도구.
const switchedOn = [mcpTool("mcp__gitlab__gitlab_issues"), mcpTool("mcp__sf1rag__rag_search")];
const conversation = (enabledTools: string[]) =>
  ({ id: "c", enabledTools, messages: [{ id: "1", role: "user", content: "안녕", createdAt: "" }] }) as never;

const none = buildTurnTools(conversation([]), switchedOn, false).turnTools;
check("입력창에서 고르지 않아도 켜 둔 커넥터의 도구는 실린다", none.has("mcp__gitlab__gitlab_issues") && none.has("mcp__sf1rag__rag_search"), [...none.keys()].join(","));
const old = buildTurnTools(conversation(["mcp__gitlab__gitlab_issues"]), switchedOn, false).turnTools;
check("예전에 하나만 골라 둔 대화도 켜 둔 서버의 도구를 모두 쓴다", old.has("mcp__sf1rag__rag_search"));
const off = buildTurnTools(conversation(["mcp__alphavantage__GLOBAL_QUOTE"]), switchedOn, false).turnTools;
check("커넥터에서 끈 서버의 도구는 대화에 이름이 남아 있어도 싣지 않는다", !off.has("mcp__alphavantage__GLOBAL_QUOTE"));
const builtin = buildTurnTools(conversation([]), switchedOn, false).turnTools;
check("기본 도구는 여전히 도구 설정(enabledTools)을 따른다", !builtin.has("calculator"));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
