// 문서 다운로드 검사. `npm test` 로 돈다.
import { documentFilename, documentsOf, markdownToPlainText } from "./documentExport";
import type { ToolCall, ToolResult } from "../api/types";

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

console.log("src/state/documentExport.ts");
const calls: ToolCall[] = [
  { id: "a", name: "create_document", arguments: { title: " 주간 보고 ", content: "# 요약\n본문", format: "md" } },
  { id: "b", name: "create_document", arguments: JSON.stringify({ title: "두 번째", content: "내용" }) },
  { id: "c", name: "create_document", arguments: { title: "거절됨", content: "x" } },
  { id: "d", name: "web_search", arguments: { query: "q" } },
  { id: "e", name: "create_document", arguments: { title: "아직", content: "결과 전" } },
];
const results: ToolResult[] = [
  { id: "a", name: "create_document", ok: true, durationMs: 1 },
  { id: "b", name: "create_document", ok: true, durationMs: 1 },
  { id: "c", name: "create_document", ok: false, durationMs: 1, error: "too long" },
  { id: "d", name: "web_search", ok: true, durationMs: 1 },
];
const docs = documentsOf(calls, results);
check("성공한 create_document 만 문서가 된다", docs.map((d) => d.id).join() === "a,b", docs.map((d) => d.id).join());
check("제목은 다듬는다", docs[0]!.title === "주간 보고");
check("원한 형식을 지킨다", docs[0]!.format === "md");
check("문자열 인자도 읽는다, 형식 기본은 pdf", docs[1]!.title === "두 번째" && docs[1]!.format === "pdf");
check("도구 호출이 없으면 빈 목록", documentsOf(undefined, undefined).length === 0);

check("파일 이름에서 금지 글자를 뺀다", documentFilename('A/B: "회의" <정리>?', "pdf") === "A B 회의 정리.pdf", documentFilename('A/B: "회의" <정리>?', "pdf"));
check("빈 제목은 '문서'", documentFilename("  ///  ", "txt") === "문서.txt");
check("긴 제목은 줄인다", documentFilename("가".repeat(200), "md").length === 83);
check("숨김 파일 이름이 되지 않는다", !documentFilename("..env", "txt").startsWith("."));

const md = "# 제목\n\n**굵게** 와 *기울임* 과 `코드`, [링크](https://x.y).\n\n> 인용\n\n| 열1 | 열2 |\n|---|---|\n| a<br>b | c |\n\n```js\n# 코드 안의 샵\n**그대로**\n```\n\n- 항목 *하나*\n";
const plain = markdownToPlainText(md);
check("제목 기호를 뺀다", plain.startsWith("제목\n"), JSON.stringify(plain.slice(0, 20)));
check("강조·코드 기호를 뺀다", plain.includes("굵게 와 기울임 과 코드,"), plain);
check("링크는 글자(주소)", plain.includes("링크 (https://x.y)"));
check("인용 기호를 뺀다", plain.includes("\n인용\n"));
check("표 구분선은 빼고 칸은 남긴다", !plain.includes("|---") && plain.includes("| 열1 | 열2 |") && plain.includes("| a / b | c |"), plain);
check("코드 블록 안은 그대로", plain.includes("# 코드 안의 샵\n**그대로**"));
check("목록 기호는 남긴다", plain.includes("- 항목 하나"));
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
