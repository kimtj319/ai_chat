// 커넥터 연결 확인 실패 문구를 한국어 한 줄로 바꾸는 규칙. `npm test` 로 돈다.
import { probeErrorSummary } from "./probeError.js";

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

function maps(name: string, raw: string, includes: string): void {
  const got = probeErrorSummary(raw);
  check(name, got !== null && got.includes(includes), `got ${JSON.stringify(got)}`);
}

console.log("src/mcp/probeError.ts");
// 감사에서 본 그대로의 문구(server/tools/net/ssrf.ts + discovery.ts 의 단계 머리).
maps("내부망 주소 차단", 'url: Blocked: "127.0.0.1" resolves to a non-public address (127.0.0.1)', "내부망");
maps("허용되지 않는 프로토콜", "url: Blocked protocol: ftp:", "https");
maps("호스트 이름을 못 찾음", "initialize: getaddrinfo ENOTFOUND mcp.example.invalid", "호스트 이름");
maps("연결 거부", "initialize: connect ECONNREFUSED 10.0.0.1:443", "연결할 수 없습니다");
maps("fetch failed", "initialize: fetch failed", "연결할 수 없습니다");
maps("시간 초과(서버가 이미 한국어로 바꾼 것)", "initialize: 응답 시간이 초과되었습니다.", "응답하지 않았습니다");
maps("401", "initialize: initialize 요청이 HTTP 401로 실패했습니다: Unauthorized", "개인 키");
maps("403", "tools/list: tools/list 요청이 HTTP 403로 실패했습니다: Forbidden", "개인 키");
maps("404", "initialize: initialize 요청이 HTTP 404로 실패했습니다: Not Found", "경로");
maps("5xx", "initialize: initialize 요청이 HTTP 502로 실패했습니다: Bad Gateway", "서버 쪽");
maps("인증서", "initialize: unable to verify the first certificate", "인증서");
maps("JSON 아님", "initialize: JSON이 아닌 응답을 받았습니다: <html>", "MCP");
check("모르는 문구는 null(원문을 그대로 보인다)", probeErrorSummary("initialize: 무언가 이상합니다") === null);
check("빈 값은 null", probeErrorSummary("") === null && probeErrorSummary(undefined) === null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
