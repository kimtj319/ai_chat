// 대화 머리 "출처 링크" 목록의 추출·묶기. `npm test` 로 돈다.
import { markdownLinks, normalizeUrl, sourceLinks, toolLinks } from "./sourceLinks.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown): void {
  if (condition) passed++;
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

const urls = (list: Array<{ url: string }>) => list.map((l) => l.url).join(" ");

console.log("src/state/sourceLinks.ts");

// ---- 주소 정규화
check("해시와 끝의 / 는 같은 페이지", normalizeUrl("https://a.com/x/#top")!.key === normalizeUrl("https://a.com/x")!.key);
check("루트의 / 도", normalizeUrl("https://a.com/")!.key === normalizeUrl("https://a.com")!.key);
check("질의 문자열은 다른 페이지", normalizeUrl("https://a.com/x?p=1")!.key !== normalizeUrl("https://a.com/x?p=2")!.key);
check("호스트 대소문자는 같다", normalizeUrl("https://A.com/x")!.key === normalizeUrl("https://a.com/x")!.key);
check("www. 는 호스트 표시에서 뗀다", normalizeUrl("https://www.a.com/x")!.hostname === "a.com");
check("javascript: 는 아니다", normalizeUrl("javascript:alert(1)") === null);
check("상대 주소는 아니다", normalizeUrl("#cite-1") === null);
check("ftp 는 아니다", normalizeUrl("ftp://a.com/f") === null);

// ---- 본문 링크
const md = [
  "자세한 내용은 [공식 문서](https://docs.a.com/guide) 와 [https://b.com/raw](https://b.com/raw) 를 보세요[1](#cite-1).",
  "그림은 빼고 ![로고](https://img.a.com/logo.png) 맨 주소 https://c.com/page. 와",
  "<https://d.com/auto> 그리고 (https://e.com/p) 와 https://f.com에서 보았다.",
  "위키 [튜링](https://en.wikipedia.org/wiki/Turing_(film)) · 나쁜 [x](javascript:alert(1))",
  "```",
  "curl https://code.example.com/inside",
  "```",
  "인라인 `https://inline.example.com` 도 코드.",
  "[참고]: https://ref.com/def",
].join("\n");
const found = markdownLinks(md);
check(
  "본문 링크를 나온 순서대로",
  found.map((m) => m.url).join(" ") ===
    [
      "https://docs.a.com/guide",
      "https://b.com/raw",
      "https://c.com/page",
      "https://d.com/auto",
      "https://e.com/p",
      "https://f.com/",
      "https://en.wikipedia.org/wiki/Turing_(film)",
      "https://ref.com/def",
    ].join(" "),
);
check("링크 글자를 제목으로", found[0]!.title === "공식 문서");
check("주소 그대로인 링크 글자는 제목이 아니다", found[1]!.title === "");
check("그림·#cite-·javascript:·코드 안 주소는 빠진다", !found.some((m) => /img\.|cite|javascript|example\.com/.test(m.url)));

// ---- 도구 결과
const search = {
  id: "c1",
  name: "web_search",
  ok: true,
  result: { query: "q", results: [{ title: "A 가이드", url: "https://docs.a.com/guide/" }, { title: "G", url: "https://g.com" }] },
};
check("web_search 결과(객체)의 results[]", urls(toolLinks(search)) === "https://docs.a.com/guide/ https://g.com/");
check(
  "MCP 결과(문자열 JSON)",
  urls(toolLinks({ name: "mcp__s__search", ok: true, result: JSON.stringify({ results: [{ url: "https://m.com/a", title: "M" }] }) })) ===
    "https://m.com/a",
);
check("JSON 이 아닌 MCP 결과는 없음", toolLinks({ name: "mcp__s__docs", ok: true, result: "plain text https://x.com" }).length === 0);
check(
  "article_extract 의 url·title",
  toolLinks({ name: "article_extract", ok: true, result: { url: "https://h.com/a", title: "H 기사" } })[0]!.title === "H 기사",
);
check(
  "http_fetch 는 호출 인자의 url",
  urls(toolLinks({ id: "c2", name: "http_fetch", ok: true, result: { status: 200, text: "..." } }, { id: "c2", name: "http_fetch", arguments: '{"url":"https://i.com/data"}' })) ===
    "https://i.com/data",
);
check("실패한 도구는 아니다", toolLinks({ ...search, ok: false }).length === 0);
check("문서 검색은 출처 링크가 아니다", toolLinks({ name: "mcp__sf1rag__rag_search", ok: true, result: '{"url":"https://r.com"}' }).length === 0);
check("주소를 다루기만 하는 도구는 아니다", toolLinks({ name: "url_parse", ok: true, result: { url: "https://u.com" } }).length === 0);
check("크롬 제어는 아니다", toolLinks({ name: "browser_open", ok: true, result: { url: "https://u.com" } }).length === 0);

// ---- 대화 전체
const first = {
  role: "assistant",
  content: "[가이드](https://docs.a.com/guide#install) 를 보세요.",
  toolCalls: [{ id: "c1", name: "web_search", arguments: { query: "q" } }],
  toolResults: [search],
};
const one = sourceLinks([{ role: "user", content: "https://user.com 질문" }, first]);
check("사용자 글의 주소는 세지 않는다", !one.some((l) => l.url.includes("user.com")));
check("본문 링크와 검색 결과가 한 줄로", one.length === 2);
check("본문이 링크한 것이 검색에만 나온 것보다 먼저", urls(one) === "https://docs.a.com/guide#install https://g.com/");
check("페이지 제목이 링크 글자보다 낫다", one[0]!.title === "A 가이드");
check("제목이 없으면 호스트와 경로", sourceLinks([{ role: "assistant", content: "https://www.n.com/x/" }])[0]!.title === "n.com/x");
check("경로의 한글은 풀어서", sourceLinks([{ role: "assistant", content: "https://ko.wikipedia.org/wiki/%EB%B2%A0" }])[0]!.title === "ko.wikipedia.org/wiki/베");
check("루트면 호스트만", sourceLinks([{ role: "assistant", content: "https://n.com/" }])[0]!.title === "n.com");

const second = { role: "assistant", content: "다시 https://g.com/ 과 [새 글](https://k.com/new)" };
const two = sourceLinks([first, { role: "user", content: "더" }, second]);
check("가장 최근 답변의 것부터, 그 안에서는 나온 순서", urls(two) === "https://g.com/ https://k.com/new https://docs.a.com/guide#install");
check("나온 답변 수를 센다", two[0]!.count === 2 && two[1]!.count === 1);
check("검색 제목은 뒤 답변의 맨 주소가 지우지 않는다", two[0]!.title === "G");
check("본문 링크 글자를 제목으로", two[1]!.title === "새 글");
check("같은 답변 안에서 두 번 나와도 한 번", sourceLinks([{ role: "assistant", content: "https://z.com https://z.com/" }])[0]!.count === 1);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) throw new Error(`${failures.length}건 실패`);
