// "~" 범위 표기가 취소선이 되지 않는지 검사. `npm test` 로 돈다.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { gfm } from "./markdownGfm.js";

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

const html = (markdown: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [gfm] }, markdown));

console.log("src/components/markdownGfm.ts");
const ranges = html("기간은 10~20일, 비용은 3~5만 원입니다.");
check("한 문단의 범위 두 개는 취소선이 아니다", !ranges.includes("<del>") && ranges.includes("10~20일"), ranges);
const inTable = html("| 구간 | 값 |\n|---|---|\n| 1~3 | 5~7 |\n");
check("표 안의 범위도 취소선이 아니다", !inTable.includes("<del>") && inTable.includes("<table>"), inTable);
const struck = html("이건 ~~지운 말~~ 입니다.");
check("물결표 두 개는 여전히 취소선", struck.includes("<del>지운 말</del>"), struck);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
