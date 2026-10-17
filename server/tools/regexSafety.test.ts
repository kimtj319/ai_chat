// regex_test 의 정적 ReDoS 거절 검사. `npx tsx server/tools/regexSafety.test.ts` 로 돈다.
//
// 사용자가 준 정규식은 이 프로세스의 메인 스레드에서 돈다. exec 는 동기라서
// 러너의 타임아웃이 끊지 못한다 — 위험한 모양을 미리 거절하지 못하면 서버
// 전체가 멈춘다. 그래서 무엇을 거절하고 무엇을 통과시키는지를 박아 둔다.
// 너무 넓게 거절하면 멀쩡한 정규식을 못 쓰고, 좁으면 서버가 멈춘다.
import { regexTestTool } from "./regexTest.js";

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

/** 거절당했으면 그 메시지를, 실행됐으면 null 을 준다. */
async function refusal(pattern: string, flags = ""): Promise<string | null> {
  try {
    await regexTestTool.execute({ pattern, text: "aaaa ab 2024 x@x", flags });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("server/tools/regexSafety.ts");

/* ------------------------------------------------------------- 거절한다 */

for (const pattern of ["(a+)+", "(a*)*", "(\\d+\\s*)+", "(.*a){25}", "(a|a)+", "(a|ab)+", "(?:x+y?)+", "(a|\\w)*"]) {
  const msg = await refusal(pattern);
  check(`위험한 모양은 거절한다: ${pattern}`, msg?.startsWith("Pattern rejected as unsafe") === true, String(msg));
}
{
  // 대소문자 무시에서는 A 와 a 가 같은 글자다.
  const msg = await refusal("(a|A)+", "i");
  check("i 플래그면 대소문자만 다른 갈래도 겹친다", msg?.startsWith("Pattern rejected as unsafe") === true, String(msg));
}

/* ------------------------------------------------------------- 통과시킨다 */

for (const pattern of ["\\d+", "(?<y>\\d{4})", "[a-z]+@x", "(ab)+", "(a|b)+", "(a+){1}", "\\b\\w+@\\w+\\.\\w+\\b", "(foo|bar)*baz"]) {
  const msg = await refusal(pattern);
  check(`안전한 정규식은 실행한다: ${pattern}`, msg === null, String(msg));
}
{
  const msg = await refusal("(a|A)+");
  check("i 플래그가 없으면 a 와 A 는 겹치지 않는다", msg === null, String(msg));
}

/* --------------------------------------------- 분석하지 못하면 RegExp 가 판정 */

{
  const msg = await refusal("(a");
  check("문법이 틀리면 RegExp 의 오류로 돌려준다", msg?.startsWith("Invalid regular expression") === true, String(msg));
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
