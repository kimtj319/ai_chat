// 출처 창 글 보기에서 마크다운 제목 표시(#)를 떼는 규칙. `npm test` 로 돈다.
import { stripHeadingMarks } from "./sourceText.js";

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
function is(name: string, got: string, expected: string): void {
  check(name, got === expected, `got ${JSON.stringify(got)}`);
}

console.log("src/state/sourceText.ts");
// 감사 화면(390-light-source-panel.png)에 그대로 보이던 모양.
is("줄 머리의 ## 를 뗀다", stripHeadingMarks("점검 12: …\n\n## 13. 일반 점검 항목 13\n\n점검 13", true), "점검 12: …\n\n13. 일반 점검 항목 13\n\n점검 13");
is("조각 맨 앞도 줄 머리면 뗀다", stripHeadingMarks("# 제목\n본문", true), "제목\n본문");
is("여섯 개까지", stripHeadingMarks("###### 작은 제목", true), "작은 제목");
is("일곱 개는 제목이 아니다", stripHeadingMarks("####### 일곱", true), "####### 일곱");
is("# 뒤에 빈칸이 없으면 제목이 아니다(#해시태그)", stripHeadingMarks("#해시태그", true), "#해시태그");
is("줄 가운데 #은 그대로", stripHeadingMarks("C# 과 F# 언어", true), "C# 과 F# 언어");
// 강조 표시로 잘린 조각: 앞 조각이 줄 중간에서 끝났으면 이 조각의 맨 앞은 줄 머리가 아니다.
is("줄 중간에서 시작한 조각의 맨 앞은 그대로", stripHeadingMarks("## 이어지는 글", false), "## 이어지는 글");
is("줄 중간 조각이라도 다음 줄 머리는 뗀다", stripHeadingMarks("이어서\n## 다음", false), "이어서\n다음");
is("글자 수가 줄어드는 것 말고는 그대로", stripHeadingMarks("가\n나", true), "가\n나");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
