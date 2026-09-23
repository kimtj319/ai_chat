// 출처 번호 검사. `npm test` 로 돈다.
//
// 번호를 매기는 규칙이 서버(모델에게 보여 줄 ref)와 화면("[n]" 링크)에 따로 적혀
// 있다. 둘이 한 번이라도 다르게 세면 "[2]" 를 눌렀을 때 모델이 말한 것과 다른
// 단락이 열린다 — 아무 오류 없이. 그래서 여기서 같은 입력으로 둘을 대조한다.
import { annotateForModel, CITATION_RULE, citationSources as serverSources } from "./citations.js";
import { citationSources as clientSources } from "../../src/state/citations.js";
import { findPassage, piecesOf } from "../../src/state/highlightMatch.js";
import { remarkCitations } from "../../src/components/citationMarkdown.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const passage = (doc: string, ord: number, text = `본문 ${doc} ${ord}`) => ({
  doc_id: `${doc}#${String(ord).padStart(3, "0")}`,
  parent_id: doc,
  title: `${doc}.pdf`,
  source: `${doc}.pdf`,
  ord: String(ord),
  score: 0.5,
  text,
});

const results = [
  { id: "a", name: "mcp__sf1rag__rag_collections", ok: true, result: JSON.stringify({ collections: ["rag"] }) },
  { id: "b", name: "mcp__sf1rag__rag_search", ok: true, result: JSON.stringify({ passages: [passage("doc_a", 1), passage("doc_b", 7)] }) },
  { id: "c", name: "calculator", ok: true, result: { value: 3 } },
  // rag_fetch 는 chunks 에 담고, 앞에서 나온 단락(doc_a#001)이 다시 온다.
  { id: "d", name: "mcp__sf1rag__rag_fetch", ok: true, result: JSON.stringify({ chunks: [passage("doc_a", 0), passage("doc_a", 1), passage("doc_a", 2)] }) },
  { id: "e", name: "mcp__sf1rag__rag_search", ok: false, error: "x" },
  { id: "f", name: "rag_search", ok: true, result: "JSON 이 아님" },
];

console.log("server/chat/citations.ts + src/state/citations.ts");
{
  const s = serverSources(results);
  const c = clientSources(results);
  check("서버와 화면이 같은 번호를 매긴다", JSON.stringify(s) === JSON.stringify(c));
  check("나온 순서대로 1부터", s.map((x) => x.chunkId).join() === "doc_a#001,doc_b#007,doc_a#000,doc_a#002", s.map((x) => x.chunkId).join());
  check("같은 단락은 처음 번호를 쓴다(중복 없음)", s.length === 4);
  check("문서 id·순번·제목을 싣는다", s[1]?.documentId === "doc_b" && s[1]?.ord === 7 && s[1]?.title === "doc_b.pdf");
  check("검색 도구가 아니거나 실패한 결과는 세지 않는다", !s.some((x) => x.documentId === "calc"));
  check("도구 결과가 없으면 빈 목록", serverSources(undefined).length === 0 && clientSources([]).length === 0);

  const annotated = JSON.parse(annotateForModel(results[3]!, s) as string);
  check("모델에게는 단락마다 ref 가 붙는다", annotated.chunks.map((p: { ref: number }) => p.ref).join() === "3,1,4", JSON.stringify(annotated.chunks.map((p: { ref: number }) => p.ref)));
  check("인용 규칙이 함께 간다", annotated.citation_rule === CITATION_RULE);
  check("다른 도구 결과는 그대로", annotateForModel(results[2]!, s) === results[2]!.result);
}

console.log("src/state/highlightMatch.ts");
{
  // PDF 추출기마다 띄어쓰기·따옴표가 다르다.
  const pdfText = "제 3 장  형태소 분석\n조사 옵션은 “P+” 로 켭니다.\n명사와 조사가 합쳐진 어절을 보존합니다. 다음 절에서 설명합니다.";
  const chunk = "조사 옵션은 \"P+\"로 켭니다. 명사와 조사가\n합쳐진 어절을 보존합니다.";
  const ranges = findPassage(pdfText, chunk);
  const painted = ranges.map((r) => pdfText.slice(r.start, r.end)).join("|");
  check("띄어쓰기·줄바꿈·따옴표가 달라도 찾는다", painted.includes("조사 옵션은") && painted.includes("보존합니다."), painted);
  check("맞닿은 문장은 한 덩어리로 칠한다(줄글)", ranges.length === 1, String(ranges.length));
  check("단락 밖은 칠하지 않는다", !painted.includes("다음 절") && !painted.includes("제 3 장"), painted);

  const md = "## 옵션\n\n| 옵션 | 동작 |\n|---|---|\n| `P+` | 조사가 합쳐진 어절 보존 |";
  check("마크다운 표시 문자는 무시한다", findPassage("옵션 P+ 조사가 합쳐진 어절 보존", "`P+` | 조사가 합쳐진 어절 보존").length === 1);
  check("짧은 조각은 찾지 않는다(우연 일치 방지)", piecesOf("예.\n아니오.").length === 0);
  check("없으면 빈 결과", findPassage(md, "전혀 다른 문장이 여기에 있습니다").length === 0);

  // 같은 문장이 여러 번 나오는 원문: 단락이 잘려 나온 곳(9·10번) 근처만 칠한다.
  const repeated = Array.from({ length: 12 }, (_, i) => `${i + 1}. 조사 결합 옵션은 어절을 색인어로 추출할지 정합니다. 이 문장은 반복됩니다.`).join("\n");
  const cut = "정합니다. 이 문장은 반복됩니다.\n9. 조사 결합 옵션은 어절을 색인어로 추출할지 정합니다. 이 문장은 반복됩니다.\n10. 조사 결합 옵션은";
  const got = findPassage(repeated, cut).map((r) => repeated.slice(r.start, r.end)).join("|");
  check("반복 문장은 단락이 잘려 나온 곳 근처만 칠한다", got.includes("9. 조사") && !got.includes("1. 조사") && !got.includes("3. 조사"), got);
  // 실제로 겪은 모양: 가장 긴 문장이 반복 문장이고, 번호가 붙은 짧은 문장만 유일하다.
  const doc = Array.from({ length: 12 }, (_, i) => `${i + 1}. 출처 보관 시험 문서입니다. 형태소 분석기의 조사 결합 옵션은 명사와 조사가 합쳐진 어절을 색인어로 추출할지 정합니다.`).join("\n");
  const chunk2 = "7. 출처 보관 시험 문서입니다. 형태소 분석기의 조사 결합 옵션은 명사와 조사가 합쳐진 어절을 색인어로 추출할\n지 정합니다.\n8. 출처 보관 시험 문서입니다.";
  const got2 = findPassage(doc, chunk2).map((r) => doc.slice(r.start, r.end)).join("|");
  check("가장 긴 문장이 반복돼도 번호가 맞는 곳을 칠한다", got2.includes("7. 출처") && got2.includes("8. 출처") && !got2.startsWith("1."), got2.slice(0, 120));
  check("…그리고 그 앞 문단(6번)은 칠하지 않는다", !got2.includes("6. 출처"), got2.slice(0, 160));
}

console.log("src/components/citationMarkdown.ts");
{
  type N = { type: string; value?: string; url?: string; children?: N[] };
  const run = (value: string, valid: number[]) => {
    const tree: N = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
    remarkCitations(new Set(valid))()(tree as never);
    return tree.children![0]!.children!;
  };
  const a = run("P 옵션입니다 [1][3]. 끝", [1, 3]);
  check("[1][3] 은 링크 둘", a.filter((n) => n.type === "link").map((n) => n.url).join() === "#cite-1,#cite-3");
  check("앞뒤 글자는 남는다", a[0]?.value === "P 옵션입니다 " && a[a.length - 1]?.value === ". 끝");
  const b = run("참고 [1, 2]", [1, 2]);
  check("[1, 2] 도 링크 둘", b.filter((n) => n.type === "link").length === 2);
  const c = run("배열 a[9] 와 [2]", [2]);
  check("목록에 없는 번호는 글자로 둔다", c.filter((n) => n.type === "link").length === 1 && c[0]?.value === "배열 a[9] 와 ");
  const code: N = { type: "root", children: [{ type: "inlineCode", value: "[1]" }] };
  remarkCitations(new Set([1]))()(code as never);
  check("인라인 코드는 건드리지 않는다", code.children![0]!.type === "inlineCode");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
