// 답변 속 도구 사용 줄(동사·질의 토막·진행 표시) 검사. `npm test` 로 돈다.
import { toolArgPreview, toolUsageSummary, toolVerb } from "./toolCopy.js";

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
function eq(name: string, got: unknown, expected: unknown): void {
  check(name, got === expected, `got ${JSON.stringify(got)}`);
}

console.log("src/state/toolCopy.ts");
eq("rag_search 는 문서 검색", toolVerb("rag_search"), "문서 검색");
eq("web_search 는 웹 검색", toolVerb("web_search"), "웹 검색");
eq("크롬 도구", toolVerb("browser_click"), "크롬 조작");
eq("GitLab MCP 도구", toolVerb("mcp__gitlab__gitlab_issues"), "GitLab 이슈 조회");
eq("이름을 아는 MCP 서버", toolVerb("mcp__alphavantage__GLOBAL_QUOTE", { alphavantage: "Alpha Vantage" }), "Alpha Vantage 사용");
eq("이름을 모르는 MCP 서버", toolVerb("mcp__weird__thing"), "도구 사용");
eq("모르는 내장 도구", toolVerb("hash_text"), "도구 사용");

eq("query 인자", toolArgPreview({ query: "출장 규정 숙박비" }), "출장 규정 숙박비");
eq("문자열 JSON 인자", toolArgPreview('{"expression":"2+2"}'), "2+2");
eq("24자에서 자른다", toolArgPreview({ q: "가".repeat(30) }), `${"가".repeat(24)}…`);
eq("인자가 없으면 null", toolArgPreview({ url: "https://x" }), null);

const calls: { name: string; arguments: unknown }[] = [
  { name: "rag_search", arguments: { query: "출장 규정 숙박비" } },
  { name: "rag_fetch", arguments: { id: "d1" } },
];
eq("끝난 두 건", toolUsageSummary(calls, ["ok", "ok"]).text, '문서 검색 · "출장 규정 숙박비" 외 1건');
eq("실패 수를 덧붙인다", toolUsageSummary(calls, ["ok", "fail"]).text, '문서 검색 · "출장 규정 숙박비" 외 1건 · 실패 1건');
eq("한 건만", toolUsageSummary(calls.slice(0, 1), ["ok"]).text, '문서 검색 · "출장 규정 숙박비"');
const three = [...calls, { name: "web_search", arguments: { query: "x" } }];
const running = toolUsageSummary(three, ["ok", "pending", "pending"]);
eq("진행 중은 마지막으로 시작한 호출", running.text, "웹 검색 중… (3/3)");
check("진행 중 표시", running.running === true);
eq("진행 중 한 건", toolUsageSummary(calls.slice(0, 1), ["pending"]).text, "문서 검색 중…");
eq("호출이 없으면 빈 글", toolUsageSummary([], []).text, "");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
