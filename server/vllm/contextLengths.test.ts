// 길이를 알려 주지 않는 모델의 컨텍스트 길이 설정 검사. `npx tsx server/vllm/contextLengths.test.ts`
const { parseContextLengths, configuredContextLength } = await import("./contextLengths.js");
let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log("server/vllm/contextLengths.ts");
check("기본값: wise-lloa-ultra 는 Gemma4 와 같은 262144", configuredContextLength("wisenut/wise-lloa-ultra-v1.1.0") === 262144);
check("기본값: wise-lloa-max 는 gpt-oss-120b 와 같은 131072", configuredContextLength("wisenut/wise-lloa-max-v1.2.1") === 131072);
check("설정에 없는 모델은 null", configuredContextLength("google/gemma-4-31B-it") === null);
const parsed = parseContextLengths("Foo=1000, bar=2000,broken,baz=-5,qux=abc");
check("대소문자 없이 앞에서부터 맞춘다", configuredContextLength("x-FOO-bar", parsed.rules) === 1000);
check("잘못된 항목은 알린다", parsed.errors.length === 3, JSON.stringify(parsed.errors));
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
