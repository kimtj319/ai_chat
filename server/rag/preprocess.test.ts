// 전처리 검사. `npm test` 로 돈다.
//
// 지키는 것은 둘이다: **본문 글자를 하나도 잃지 않는다**, 그리고 **본문이
// 아닌 것은 남기지 않는다**. 앞의 것이 깨지면 사용자는 자기 문서의 일부가
// 조용히 사라진 줄도 모르고, 뒤의 것이 깨지면 전처리를 한 뜻이 없다.
import { describeReport, preprocess } from "./preprocess.js";

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

const run = (text: string, paged = false) => preprocess(text, { paged });

console.log("server/rag/preprocess.ts");

/* ------------------------------------------------------------ 본문은 건드리지 않는다 */

{
  const body = "색인 API 는 POST /index/{컬렉션} 이다.\n\n응답은 result 와 success 를 담는다.";
  eq("평범한 글은 그대로 나온다", run(body).text, body);
}
{
  const md = "# 제목\n\n| 이름 | 값 |\n| --- | --- |\n| a | 1 |\n\n- 항목\n- 항목\n\n```\ncode();\n```";
  eq("마크다운은 표·구분선까지 그대로다", run(md).text, md);
}
{
  // paged 를 켜지 않으면 숫자만 있는 줄도 본문이다 — 마크다운의 진짜 내용일 수 있다.
  eq("쪽번호 제거는 paged 일 때만 한다", run("가\n12\n나").text, "가\n12\n나");
}

/* ---------------------------------------------------------------- 쪽번호 */

{
  const r = run("첫 쪽 내용\n1\n\n둘째 쪽 내용\n2\n\n셋째 쪽 내용\n3", true);
  eq("쪽번호 줄이 사라진다", r.text, "첫 쪽 내용\n\n둘째 쪽 내용\n\n셋째 쪽 내용");
  eq("몇 줄을 지웠는지 센다", r.report.pageNumbers, 3);
}
{
  eq("로마숫자 쪽번호도 지운다", run("머리말\nii\n본문", true).text, "머리말\n본문");
  eq("`- 12 -` 꼴도 지운다", run("본문\n- 12 -\n다음", true).text, "본문\n다음");
  check("숫자로 시작하는 문장은 남는다", run("2024년 개정판", true).text === "2024년 개정판");
  check("번호 목록은 남는다", run("1. 제품 개요", true).text === "1. 제품 개요");
  check("네 자리를 넘는 수는 쪽번호가 아니다", run("12345", true).text === "12345");
}

/* --------------------------------------------------------- 잘못 읽은 줄 */

{
  const garbage = "Í Í0Í@ÍPÍ`ÍpÍ Í!Í\"";
  const r = run(`정상 문장이다.\n${garbage}\n다음 문장이다.`);
  eq("깨진 줄이 사라진다", r.text, "정상 문장이다.\n다음 문장이다.");
  eq("몇 줄인지 센다", r.report.garbled, 1);
}
{
  const line = "Copyright © Example Corp. All Rights Reserved";
  eq("기호가 한둘 섞인 정상 문장은 남는다", run(line).text, line);
  const accented = "Café naïve résumé façade";
  eq("악센트 있는 라틴 문장도 남는다", run(accented).text, accented);
  eq("짧은 줄은 깨졌다고 보지 않는다", run("ÍÍÍ").text, "ÍÍÍ");
}

/* ------------------------------------------------------------ 보이지 않는 글자 */

{
  const r = run("검색\u0000어\u200b와\ufeff 결과");
  eq("제어·서식 문자가 사라진다", r.text, "검색어와 결과");
  check("남은 글자에 보이지 않는 것이 없다", !/[\u0000-\u0008\u200b\ufeff]/.test(r.text));
}
{
  eq("NBSP 는 보통 공백이 된다", run("가 나").text, "가 나");
  eq("전각 공백도 보통 공백이 된다", run("가　나").text, "가 나");
}
{
  // 자모가 풀린 한글은 눈에 같아 보여도 검색어와 만나지 못한다.
  const decomposed = "\u1100\u1161\u1102\u1161"; // 가나 (NFD)
  eq("한글을 NFC 로 모은다", run(decomposed).text, "가나");
}

/* ------------------------------------------------------------------ 공백·빈 줄 */

{
  eq("줄 앞뒤 공백을 없앤다", run("   들여쓴 줄   \n  또 한 줄  ").text, "들여쓴 줄\n또 한 줄");
  eq("줄 안의 연속 공백은 하나로", run("표    칸    사이").text, "표 칸 사이");
  eq("빈 줄이 셋 이상이면 하나로", run("가\n\n\n\n\n나").text, "가\n\n나");
  eq("문단 경계인 빈 줄 하나는 남는다", run("가\n\n나").text, "가\n\n나");
  eq("CRLF 는 LF 가 된다", run("가\r\n나").text, "가\n나");
}

/* -------------------------------------------------------------- 영어 분철 */

{
  const r = run("config-\nuration 을 고친다");
  eq("줄 끝에서 잘린 낱말을 붙인다", r.text, "configuration 을 고친다");
  eq("몇 번 붙였는지 센다", r.report.rejoined, 1);
  eq("한국어는 붙이지 않는다", run("설정-\n파일").text, "설정-\n파일");
  eq("다음 줄이 대문자면 붙이지 않는다", run("Foo-\nBar").text, "Foo-\nBar");
}

/* ------------------------------------------------------ 글자를 잃지 않는다 */

{
  // 이 검사가 이 파일에서 가장 중요하다: 본문 글자는 공백을 빼고 그대로여야 한다.
  const doc = [
    "1. 제품 개요",
    "SF-1 은 검색 엔진이다. POST /index/{컬렉션} 으로 색인한다.",
    "",
    "1",
    "Í Í0Í@ÍPÍ`Íp",
    "   들여쓴 본문 줄   ",
    "config-",
    "uration 값을 바꾼다.",
  ].join("\n");
  const r = preprocess(doc, { paged: true });
  const squeeze = (s: string) => s.replace(/\s+/g, "");
  const expected = squeeze("1. 제품 개요SF-1 은 검색 엔진이다. POST /index/{컬렉션} 으로 색인한다.들여쓴 본문 줄configuration 값을 바꾼다.");
  eq("덜어낸 것 말고는 글자가 그대로다", squeeze(r.text), expected);
  eq("쪽번호 1줄", r.report.pageNumbers, 1);
  eq("깨진 줄 1줄", r.report.garbled, 1);
  eq("분철 1회", r.report.rejoined, 1);
}

/* --------------------------------------------------------------- 자잘한 것 */

{
  eq("빈 입력도 받는다", run("").text, "");
  eq("공백뿐인 입력도 받는다", run("   \n\n  ").text, "");
  const r = run("가나다");
  eq("아무것도 안 지웠으면 요약은 빈 문자열", describeReport(r.report), "");
  const r2 = preprocess("본문\n7\n본문", { paged: true });
  check("지웠으면 요약이 말해 준다", describeReport(r2.report).includes("쪽번호"), describeReport(r2.report));
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
