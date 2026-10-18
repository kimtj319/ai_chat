// 출처 단락을 **올린 원본** 속에서 찾는 검사. `npm test` 로 돈다.
//
// 왜 필요한가: 색인한 청크는 전처리(server/rag/preprocess.ts)를 거친 글이다 —
// NFC 로 모으고, 보이지 않는 글자를 지우고, 줄 끝에서 잘린 영어 낱말을 붙인다.
// 오른쪽 창은 이제 그 정리본이 아니라 원본을 띄우므로, 정리된 청크로 원본의 제자리를
// 찾아야 한다. 정리 전후가 다른 글자는 비교할 때 같은 것으로 쳐야 한다.
//
// 아래 "청크" 문자열은 preprocess 가 원본에서 실제로 만들어 내는 모양을 손으로 옮긴
// 것이다(브라우저 타입체크를 받는 src/ 라서 서버 코드를 끌어오지 않는다).
//
// 브라우저 타입체크를 받는 src/ 아래이므로 `process` 는 쓰지 않고, 실패는
// throw 로 표시한다(src/routes.test.ts 와 같은 규칙).
import { findPassage, type Range } from "./highlightMatch.js";

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failures.push({ name, message: detail });
  }
}

/** 칠한 범위가 원본에서 단락이 차지하는 자리와 **정확히** 같은가. */
function covers(original: string, ranges: Range[], first: string, last: string): boolean {
  if (ranges.length === 0) return false;
  const start = ranges[0]!.start;
  const end = ranges[ranges.length - 1]!.end;
  return original.slice(start).startsWith(first) && original.slice(0, end).endsWith(last);
}

function show(original: string, ranges: Range[]): string {
  return JSON.stringify(ranges.map((r) => original.slice(r.start, r.end)));
}

{
  // 맥에서 만든 파일은 한글 자모가 풀린(NFD) 채로 올 수 있다. 청크는 NFC 다.
  const lead = "앞 문단은 상관없는 내용입니다. 여기는 칠하면 안 됩니다.\n\n";
  const body = "검색 엔진은 문서를 청크로 나눕니다. 청크마다 벡터를 만듭니다.";
  const original = (lead + body + "\n\n뒤 문단도 상관없습니다. 마지막 줄입니다.").normalize("NFD");
  const chunk = body; // preprocess 는 NFC 로 모은다
  const ranges = findPassage(original, chunk);
  check(
    "NFD 원본에서 NFC 청크의 제자리를 찾는다",
    covers(original, ranges, "검".normalize("NFD"), "다.".normalize("NFD")) &&
      original.slice(ranges[0]!.start).normalize("NFC").startsWith("검색 엔진은"),
    show(original, ranges),
  );
}

{
  // 소프트 하이픈·단어 결합자·방향 표시·제어문자: 화면엔 안 보이고 preprocess 가 지운다.
  const original =
    "머리말입니다. 이 문장은 칠하지 않습니다.\n\n소프트­하이픈과 단어⁠결합자, 방향‎표시가 섞인 문장입니다. 제어\u0007문자도 있습니다.\n\n끝.";
  const chunk = "소프트하이픈과 단어결합자, 방향표시가 섞인 문장입니다. 제어문자도 있습니다.";
  const ranges = findPassage(original, chunk);
  check("보이지 않는 글자가 섞인 원본에서도 단락 전체를 찾는다", covers(original, ranges, "소프트", "있습니다."), show(original, ranges));
  check("보이지 않는 글자 때문에 형광펜이 끊기지 않는다", ranges.length === 1, show(original, ranges));
}

{
  // 줄 끝에서 잘린 영어 낱말은 preprocess 가 붙인다("configu-\nration" → "configuration").
  const original =
    "Intro paragraph that is not cited at all.\n\nThe configu-\nration file controls the engine. Each chunk is embed-\nded at index time.\n\nOutro.";
  const chunk = "The configuration file controls the engine. Each chunk is embedded at index time.";
  const ranges = findPassage(original, chunk);
  check("줄 끝에서 잘린 영어 낱말을 붙인 청크도 원본에서 찾는다", covers(original, ranges, "The configu-", "index time."), show(original, ranges));
}

{
  // 줄 안의 연속 공백·탭은 하나로, CRLF 는 LF 로 — 표를 옮긴 원본에 흔하다.
  const original = "# 설정\r\n\r\n| 이름    |\t값     |\r\n|---------|--------|\r\n| 포트    | 9400   |\r\n\r\n다음 절.";
  const chunk = "# 설정\n\n| 이름 | 값 |\n|---------|--------|\n| 포트 | 9400 |";
  const ranges = findPassage(original, chunk);
  check("CRLF·열 맞춤 공백이 있는 원본 표에서 청크를 찾는다", covers(original, ranges, "설정", "9400"), show(original, ranges));
}

{
  // 돌려주는 위치는 원본 글자 위치다 — 정리본 위치를 그대로 쓰면 앞에 지워진 글자 수만큼 밀린다.
  const original = "﻿​​​머리 줄.\n\n찾을 문장은 바로 여기에 있습니다. 이어지는 둘째 문장입니다.";
  const chunk = "찾을 문장은 바로 여기에 있습니다. 이어지는 둘째 문장입니다.";
  const ranges = findPassage(original, chunk);
  check("앞에서 지워진 글자만큼 위치가 밀리지 않는다", ranges[0]?.start === original.indexOf("찾을"), show(original, ranges));
}

console.log("src/state/highlightMatch.ts (원본 위치)");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  throw new Error(`${failures.length} highlightMatch check(s) failed`);
}
