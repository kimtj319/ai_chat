// 추론 프로필 설정 해석 검사. `npm test` 로 돈다.
//
// 이 해석이 틀리면 **오류 없이 추론 설정만 달라진다.** 패턴 하나를 못 알아보면
// 그 모델은 기본 프로필로 떨어져, 게이트웨이가 거절하는 필드를 계속 보내거나
// (400) 보내야 할 예산을 안 보낸다. 화면에는 그냥 답이 이상하게 나올 뿐이다.
//
// config 는 불러들일 때 환경변수를 읽으므로 import 보다 먼저 세운다.
process.env.REASONING_PROFILES = "";

const { parseReasoningProfiles } = await import("./reasoningProfiles.js");

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

console.log("server/chat/reasoningProfiles.ts");

/* ------------------------------------------------------------ 알아듣는 것 */

{
  const { rules, errors } = parseReasoningProfiles("model-a=fixed");
  check("fixed 를 읽는다", rules.length === 1 && rules[0]?.profile.control === "fixed", JSON.stringify(rules));
  check("  불평하지 않는다", errors.length === 0, errors.join(" / "));
}
{
  const { rules } = parseReasoningProfiles("model-b=budget:256");
  check("budget:N 을 읽는다", rules[0]?.profile.control === "budget" && rules[0]?.profile.minBudget === 256, JSON.stringify(rules));
}
{
  const { rules } = parseReasoningProfiles("model-c=budget");
  check("최소값을 안 적으면 기본값을 쓴다", rules[0]?.profile.control === "budget" && rules[0]?.profile.minBudget === 128, JSON.stringify(rules));
}
{
  const { rules, errors } = parseReasoningProfiles(" A-Model =FIXED , other = budget:64 ");
  check("공백과 대문자를 견딘다", rules.length === 2, JSON.stringify(rules));
  check("  패턴은 소문자로 모은다", rules[0]?.pattern === "a-model", String(rules[0]?.pattern));
  check("  그리고 둘 다 제대로 읽힌다",
    rules[0]?.profile.control === "fixed" && rules[1]?.profile.minBudget === 64, JSON.stringify(rules));
  check("  불평하지 않는다", errors.length === 0, errors.join(" / "));
}
{
  const { rules } = parseReasoningProfiles("");
  check("빈 설정은 규칙 없음 — 모두 기본 프로필", rules.length === 0);
}
{
  const { rules, errors } = parseReasoningProfiles("a=fixed,,  ,b=fixed");
  check("빈 항목은 그냥 건너뛴다", rules.length === 2, JSON.stringify(rules));
  check("  그것으로 불평하지는 않는다", errors.length === 0, errors.join(" / "));
}

/* --------------------------------------------- 못 알아듣는 것은 말해야 한다 */

{
  // 이 네 줄이 이 파일의 존재 이유다. 조용히 버리면 아무도 모른다.
  for (const bad of ["model-a", "model-a=turbo", "=fixed", "model-a=budget:abc"]) {
    const { rules, errors } = parseReasoningProfiles(bad);
    check(`알아볼 수 없으면 알린다: ${bad}`, errors.length === 1, JSON.stringify(errors));
    check(`  그리고 규칙으로 세지 않는다: ${bad}`, rules.length === 0, JSON.stringify(rules));
  }
}
{
  // 하나가 틀려도 나머지는 살린다 — 오타 하나에 전체가 무력화되면 더 나쁘다.
  const { rules, errors } = parseReasoningProfiles("good=fixed,bad=turbo,also-good=budget:32");
  check("틀린 것 하나가 나머지를 죽이지 않는다", rules.length === 2, JSON.stringify(rules));
  check("  그러면서 틀린 것은 알린다", errors.length === 1, errors.join(" / "));
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
