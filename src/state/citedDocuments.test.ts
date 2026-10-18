// 대화 머리 "출처 문서" 목록의 묶기. `npm test` 로 돈다.
import { citedDocuments } from "./citations.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown): void {
  if (condition) passed++;
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

function rag(passages: Array<{ id: string; title?: string }>) {
  return [
    {
      name: "mcp__sf1rag__rag_search",
      ok: true,
      result: JSON.stringify({
        passages: passages.map((p) => ({ doc_id: p.id, title: p.title ?? p.id.split("#")[0], text: `단락 ${p.id}` })),
      }),
    },
  ];
}

console.log("src/state/citations.ts — citedDocuments");

check("인용이 없으면 빈 목록", citedDocuments([{ role: "assistant", content: "그냥 답", toolResults: [] }]).length === 0);

// 답변 1: a#1[1], b#2[2], a#3[3] — 검색만 되고 본문에 안 나온 c#1[4] 는 세지 않는다.
const first = { role: "assistant", content: "가[1] 나[2] 다[1, 3]", toolResults: rag([{ id: "a#1" }, { id: "b#2" }, { id: "a#3" }, { id: "c#1" }]) };
const one = citedDocuments([{ role: "user", content: "[1] 질문" }, first]);
check("본문에 링크된 문서만", one.map((d) => d.documentId).join() === "a,b");
check("문서마다 인용한 단락 수", one[0]!.count === 2 && one[1]!.count === 1);
check("같은 답변 안에서는 처음 나온 순서", one[0]!.documentId === "a");
check("고르면 그 문서에서 처음 나온 단락", one[0]!.source.chunkId === "a#1");
check("사용자 글의 [1] 은 세지 않는다", one.length === 2);

// 답변 2: b 를 다시 인용 — b 가 맨 위로, 여는 단락은 최근 답변의 것.
const second = { role: "assistant", content: "다시 [2] 와 [1]", toolResults: rag([{ id: "d#1", title: "D 문서" }, { id: "b#5" }]) };
const two = citedDocuments([first, { role: "user", content: "더" }, second]);
check("가장 최근에 인용한 문서가 먼저", two.map((d) => d.documentId).join() === "b,d,a");
check("다시 인용되면 최근 답변의 단락으로 연다", two[0]!.source.chunkId === "b#5");
check("단락 수는 대화 전체에서 센다", two[0]!.count === 2);
check("제목을 쓴다", two[1]!.title === "D 문서");

const mixed = citedDocuments([{ role: "assistant", content: "없는 번호 [1, 9] 와 [2]", toolResults: rag([{ id: "a#1" }, { id: "b#1" }]) }]);
check("묶음에 없는 번호가 있으면 그 묶음은 글자로 남는다(링크와 같은 규칙)", mixed.map((d) => d.documentId).join() === "b");

const failed = citedDocuments([{ role: "assistant", content: "[1]", toolResults: [{ name: "rag_search", ok: false, result: "{}" }] }]);
check("실패한 도구 결과는 출처가 아니다", failed.length === 0);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) throw new Error(`${failures.length}건 실패`);
