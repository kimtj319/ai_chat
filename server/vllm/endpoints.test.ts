// 모델 엔드포인트 주소 검사. `npm test` 로 돈다.
//
// 관리자가 화면에 붙여 넣는 주소를 여기서 한 모양으로 다듬는다. 이게 틀리면
// **다른 모델로 요청이 간다** — 그리고 답은 정상적으로 돌아오므로 아무도
// 이상하다고 느끼지 않는다. 그래서 빈 값·없는 스킴·끝의 빗금처럼 사람이 실제로
// 붙여 넣는 모양들을 전부 같은 결과로 모으는지 본다.
//
// 같은 주소가 두 모양으로 저장되면 endpointSource·isEnvEndpoint 가 둘을 다른
// 것으로 보아 중복 항목이 생기고, 지워도 안 지워지는 엔드포인트가 남는다.
import { isEnvEndpoint, normalizeBaseUrl } from "./endpoints.js";

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

console.log("server/vllm/endpoints.ts — normalizeBaseUrl");

/* ------------------------------------------- 사람이 실제로 붙여 넣는 모양들 */

{
  // 이 다섯 가지는 전부 같은 곳을 가리킨다. 하나라도 다른 결과가 나오면
  // 같은 서버가 두 개로 등록된다.
  const same = [
    "10.0.0.10:8000",
    "http://10.0.0.10:8000",
    "http://10.0.0.10:8000/",
    "http://10.0.0.10:8000/v1",
    "  http://10.0.0.10:8000/v1/  ",
  ];
  const results = same.map(normalizeBaseUrl);
  eq("host:port 는 /v1 이 붙는다", results[0], "http://10.0.0.10:8000/v1");
  check("다섯 가지가 모두 같은 값이 된다", new Set(results).size === 1, JSON.stringify(results));
}
{
  eq("스킴이 없으면 http 를 붙인다", normalizeBaseUrl("localhost:8000"), "http://localhost:8000/v1");
  eq("https 는 그대로 둔다", normalizeBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");
  eq("끝의 빗금 여러 개도 정리한다", normalizeBaseUrl("http://a.b:1/v1///"), "http://a.b:1/v1");
  eq("기본 포트는 생략된다", normalizeBaseUrl("https://api.example.com"), "https://api.example.com/v1");
}
{
  // /v1 이 아닌 경로를 준 경우는 그 경로를 존중한다 — 게이트웨이 뒤에 붙는
  // 배포가 실제로 있다(LiteLLM).
  eq("다른 경로는 건드리지 않는다", normalizeBaseUrl("http://gw:30100/openai/v1"), "http://gw:30100/openai/v1");
}

/* ----------------------------------------------------------- 거절할 것들 */

{
  for (const [label, input] of [
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["문자열이 아님", 123],
    ["null", null],
    ["undefined", undefined],
    ["객체", {}],
    ["ftp", "ftp://host/x"],
    ["file", "file:///etc/passwd"],
    ["스킴만", "http://"],
  ] as const) {
    eq(`거절한다: ${label}`, normalizeBaseUrl(input), null);
  }
}

/* --------------------------------------------- .env 에서 온 것인지 가리기 */

{
  // 이 판단이 틀리면 .env 로 고정한 엔드포인트를 화면에서 지울 수 있게 되고,
  // 지워도 재기동하면 돌아와 "지워지지 않는다" 로 보인다.
  const known = normalizeBaseUrl("10.0.0.10:8000");
  check("정규화된 주소로 물어야 한다", typeof known === "string");
  check("모르는 주소는 .env 것이 아니다", isEnvEndpoint("http://아무데도.없음:1/v1") === false);
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
