// 문서 분할 테스트. `npm test` 로 돈다.
//
// 지키는 것은 둘이다: **글자를 잃지 않는다**, 그리고 **어느 조각도 한도를
// 넘지 않는다**. 앞의 것이 깨지면 사용자는 자기 문서의 일부가 조용히 사라진
// 줄도 모르고, 뒤의 것이 깨지면 나눈 의미가 없다.
import { partName, splitForIndexing } from "./split.js";

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const squeeze = (s: string) => s.replace(/\s+/g, "");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

console.log("server/rag/split.ts");

/* ------------------------------------------------------------------ 테스트 자료 */

const PARA = (n: number) =>
  `${n}번 문단이다. 색인 API 는 POST /index/{컬렉션} 이고 본문은 문서 객체의 배열이다. ` +
  `응답은 result 와 success, fail, total 을 담는다. 문서가 전부 실패해도 HTTP 200 이 돌아온다.`;

const WITH_HEADINGS = Array.from({ length: 12 }, (_, i) => `## ${i + 1}장 제목\n\n${PARA(i + 1)}\n\n${PARA(i + 1)}`).join("\n\n");
const NO_HEADINGS = Array.from({ length: 20 }, (_, i) => PARA(i + 1)).join("\n\n");
const ONE_LINE = "가나다라마바사".repeat(3000); // 줄바꿈이 없는 거대한 한 줄

/* -------------------------------------------------------------------- 테스트 */

{
  const parts = splitForIndexing("짧은 문서다.", 1024);
  eq("한도 안이면 나누지 않는다", parts.length, 1);
  eq("그때 total 은 1", parts[0].total, 1);
  eq("본문은 그대로", parts[0].text, "짧은 문서다.");
}

for (const [label, doc, limit] of [
  ["제목이 있는 문서", WITH_HEADINGS, 2000],
  ["제목이 없는 문서", NO_HEADINGS, 2000],
  ["줄바꿈 없는 한 줄", ONE_LINE, 4000],
  ["아주 작은 한도", WITH_HEADINGS, 600],
] as const) {
  const parts = splitForIndexing(doc, limit);
  check(`${label}: 여러 조각으로 나뉜다`, parts.length > 1, `${parts.length}조각`);
  check(
    `${label}: 이어 붙이면 원문이다`,
    squeeze(parts.map((p) => p.text).join("")) === squeeze(doc),
    `원문 ${squeeze(doc).length}자 → ${squeeze(parts.map((p) => p.text).join("")).length}자`,
  );
  const over = parts.filter((p) => bytes(p.text) > limit);
  eq(`${label}: 한도를 넘는 조각이 없다`, over.length, 0);
  check(
    `${label}: 번호가 1..n 으로 이어진다`,
    parts.every((p, i) => p.index === i + 1 && p.total === parts.length),
    parts.map((p) => `${p.index}/${p.total}`).join(" "),
  );
  check(`${label}: 빈 조각이 없다`, parts.every((p) => p.text.trim().length > 0), "");
}

{
  // 제목이 있으면 장 중간에서 끊지 않는다 — 나뉜 조각이 그 자체로 읽혀야 한다.
  const parts = splitForIndexing(WITH_HEADINGS, 2000);
  const startsAtHeading = parts.filter((p) => /^##\s/.test(p.text.trim())).length;
  check(
    "제목이 있으면 장 첫머리에서 시작한다",
    startsAtHeading >= parts.length - 1,
    `${startsAtHeading}/${parts.length} 조각이 제목으로 시작`,
  );
}

{
  eq("이름에 번호가 붙는다", partName("보고서.pdf", 2, 3), "보고서 (2/3).pdf");
  eq("확장자가 없어도 된다", partName("보고서", 1, 2), "보고서 (1/2)");
  eq("한 개면 이름을 건드리지 않는다", partName("보고서.pdf", 1, 1), "보고서.pdf");
  eq("점이 여럿이면 마지막이 확장자다", partName("v7.4 매뉴얼.md", 1, 2), "v7.4 매뉴얼 (1/2).md");
}

{
  // 한국어는 글자당 3바이트다. 글자 수로 재면 한도를 세 배 넘긴다.
  const korean = "가".repeat(5000);
  const parts = splitForIndexing(korean, 3000);
  const over = parts.filter((p) => bytes(p.text) > 3000);
  eq("한국어도 바이트 기준으로 지켜진다", over.length, 0);
  check("그리고 글자를 잃지 않는다", parts.map((p) => p.text).join("") === korean, "");
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
