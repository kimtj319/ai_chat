// 블록 묶음으로 나눠 그린 답이 통째로 그린 답과 글자 하나 다르지 않은지 검사. `npm test` 로 돈다.
//
// MarkdownRenderer 는 답을 splitMarkdownBlocks 로 나눠 묶음마다 따로 그리고 "\n" 으로
// 잇는다. 여기서는 같은 플러그인(MarkdownRenderer 와 같은 순서)으로 둘을 정적 HTML 로
// 그려 비교한다 — 다 온 답 하나와, 흘러 들어오는 도중의 모든 길이(stableStreamingMarkdown
// 을 거친 것)에서.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { splitMarkdownBlocks, stableStreamingMarkdown } from "../state/streamingMarkdown.js";
import { remarkCitations } from "./citationMarkdown.js";
import { remarkBreakTags } from "./markdownBreaks.js";
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

const remarkPlugins = [gfm, remarkMath, remarkBreakTags, remarkCitations(new Set([1, 2, 3]))];
const rehypePlugins = [rehypeHighlight, rehypeKatex];
const render = (markdown: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, markdown));
const renderSplit = (markdown: string, minChars: number) =>
  splitMarkdownBlocks(markdown, minChars).map(render).join("\n");

/** 처음 어긋나는 자리 앞뒤를 보여 준다. */
function diff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `@${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} ≠ ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
}

const SAMPLE = [
  "# 검색 엔진 정리\n\n",
  "색인기는 문서를 받아 역색인을 만든다[1]. 질의 처리기는 점수를 매긴다 [2, 3].\n줄 안의 <br> 줄바꿈과 10~20일 범위.\n\n",
  "- 첫째 항목\n- 둘째 항목\n  - 하위 항목\n  - 하위 항목 둘\n- 셋째\n\n",
  "1. 느슨한 목록 첫째\n\n   이어지는 문단\n\n2. 느슨한 목록 둘째\n\n",
  "중간 문단입니다.\n\n",
  "3. 번호가 이어지는 새 목록\n4. 넷째\n\n",
  "- [ ] 할 일\n- [x] 한 일\n\n",
  "| 항목 | 기본값 | 설명 |\n|---|---:|:---:|\n| 설정1 | 128 | 성능에 영향 |\n| 설정2 | 256 | 메모리 `heap` |\n\n",
  "```python\ndef score(doc, q):\n    tf = doc.count(q)\n\n\n    return tf / (tf + 1.2)\n\nprint(score)\n```\n\n",
  "````markdown\n```js\nconst a = 1;\n```\n\n본문처럼 보이는 줄\n````\n\n",
  "~~~bash\n./engine.sh start\n\necho done\n~~~\n\n",
  "```\n언어 없는 코드\n\n둘째 줄\n```\n\n",
  "점수는 $s = \\frac{tf}{tf + k_1}$ 로 계산하고 $$x^2$$ 도 있다.\n\n",
  "$$\n\\sum_{t \\in q} \\mathrm{IDF}(t)\n\n\\cdot f(t, d)\n$$\n\n",
  "> 참고: 운영 환경에서는 힙을 고정한다.\n>\n> 둘째 줄\n\n> 다른 인용\n\n",
  "제목 아래 줄\n===\n\n---\n\n",
  "    들여쓴 코드\n\n    이어지는 들여쓴 코드\n\n",
  "끝 문단과 **굵게**, *기울임*, ~~취소~~, https://example.com 자동 링크.\n",
].join("");

console.log("src/state/streamingMarkdown.ts splitMarkdownBlocks + src/components/MarkdownRenderer.tsx");

// 1) 다 온 답: 잘게(minChars 0) 나눠도, 기본값으로 나눠도 같다.
const whole = render(SAMPLE);
const pieces = splitMarkdownBlocks(SAMPLE, 0);
check("견본이 실제로 여러 묶음으로 나뉜다", pieces.length >= 10, String(pieces.length));
check("나눈 조각을 이으면 원문 그대로", pieces.join("") === SAMPLE);
const split0 = renderSplit(SAMPLE, 0);
check("잘게 나눠 그려도 통째로 그린 것과 같다", split0 === whole, diff(whole, split0));
check("기본 묶음 크기로 나눠 그려도 같다", renderSplit(SAMPLE, 1500) === whole);
check("수식·코드 색칠·표·출처 링크가 다 들어 있다", ["katex", "hljs", "<table>", "#cite-2"].every((s) => whole.includes(s)));

// 2) 흘러 들어오는 도중: 길이마다 stableStreamingMarkdown 을 거친 글을 나눠 그려도 같고,
//    앞에서 끝났다고 정한 묶음은 글이 늘어도 바뀌지 않는다.
let mismatches = 0;
let firstMismatch = "";
let unstable = 0;
let previous: string[] = [];
for (let end = 1; end <= SAMPLE.length; end += 3) {
  const text = stableStreamingMarkdown(SAMPLE.slice(0, end));
  const expected = render(text);
  const got = renderSplit(text, 0);
  if (got !== expected) {
    mismatches++;
    firstMismatch ||= `len ${end}: ${diff(expected, got)}`;
  }
  const blocks = splitMarkdownBlocks(text, 0);
  const finished = previous.slice(0, -1);
  if (finished.some((block, i) => blocks[i] !== block)) unstable++;
  previous = blocks;
}
check("흘러 들어오는 모든 길이에서 같다", mismatches === 0, `${mismatches}곳, 처음: ${firstMismatch}`);
check("끝난 묶음은 글이 늘어도 그대로다", unstable === 0, String(unstable));

// 3) 나누면 안 되는 경우.
const withDefinition = "앞 문단 [참고][r]\n\n뒷 문단\n\n[r]: https://example.com\n";
check("참조 정의가 있으면 나누지 않는다", splitMarkdownBlocks(withDefinition, 0).length === 1);
const withFootnote = "본문[^1]\n\n뒷 문단\n\n[^1]: 각주\n";
check("각주 정의가 있으면 나누지 않는다", splitMarkdownBlocks(withFootnote, 0).length === 1);
check("각주가 있는 답도 같게 그린다", renderSplit(withFootnote, 0) === render(withFootnote));
const withHtml = "앞 문단\n\n<!--\n\n주석 안\n\n-->\n\n뒷 문단\n\n끝\n";
const htmlBlocks = splitMarkdownBlocks(withHtml, 0);
check("HTML 블록이 나오면 그 앞뒤로 자르지 않는다(빈 줄을 넘어 이어질 수 있다)", htmlBlocks.length === 1, JSON.stringify(htmlBlocks));
check("HTML 블록이 있는 답도 같게 그린다", renderSplit(withHtml, 0) === render(withHtml));
check("열린 울타리 안의 빈 줄에서는 자르지 않는다", splitMarkdownBlocks("앞\n\n```\n코드\n\n코드 둘\n", 0).length === 2);
check("다 오지 않은 줄 앞에서는 자르지 않는다", splitMarkdownBlocks("앞 문단\n\n뒷", 0).length === 1);
check("목록 표시 줄 앞에서는 자르지 않는다", splitMarkdownBlocks("- 하나\n\n- 둘\n", 0).length === 1);
check("짧은 답은 기본 크기에서 한 묶음", splitMarkdownBlocks("가\n\n나\n\n다\n").length === 1);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
