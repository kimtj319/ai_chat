// 답변 속 <br> 이 글자로 보이지 않는지 검사. `npm test` 로 돈다.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { gfm } from "./markdownGfm.js";
import { remarkBreakTags } from "./markdownBreaks.js";

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

const html = (markdown: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [gfm, remarkBreakTags] }, markdown));

console.log("src/components/markdownBreaks.ts");
// react-markdown 은 <br/> 뒤에 줄바꿈 문자를 하나 넣는다 — 비교에서는 뺀다.
const flat = (markdown: string) => html(markdown).replace(/<br\/>\n/g, "<br/>");
const table = flat("| a | b |\n|---|---|\n| 1<br>2<br/>3 | x<BR />y |\n");
check("표 칸의 <br> 은 줄바꿈이 된다", table.includes("<td>1<br/>2<br/>3</td>") && table.includes("<td>x<br/>y</td>"), table);
check("글자 그대로의 <br> 은 남지 않는다", !table.includes("&lt;br"), table);
const para = flat("첫째<br>둘째");
check("문단의 <br> 도 줄바꿈", para === "<p>첫째<br/>둘째</p>", para);
const code = html("코드 `<br>` 와\n\n```html\n<br>\n```");
check("코드 안의 <br> 은 그대로 보인다", code.includes("<code>&lt;br&gt;</code>") && code.includes("&lt;br&gt;\n</code>"), code);
const other = html("굵게<b>안됨</b>");
check("다른 HTML 은 여전히 그리지 않는다", !other.includes("<b>"), other);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
