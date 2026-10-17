// 답변 오류를 한국어 안내로 바꾸는 규칙 검사. `npm test` 로 돈다.
import { friendlyError } from "./friendlyError.js";

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

const NETWORK = "연결이 끊겨 답변을 끝까지 받지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.";
const MODEL_SERVER = "모델 서버가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.";
const RATE_LIMITED = "요청이 많아 잠시 처리할 수 없습니다. 1분쯤 뒤 다시 시도해 주세요.";
const UNAUTHORIZED = "로그인이 만료되었습니다. 다시 로그인해 주세요.";
const GENERIC = "답변을 만들지 못했습니다.";

function is(name: string, raw: string | undefined, expected: string | null): void {
  const got = friendlyError(raw);
  check(name, got === expected, `got ${JSON.stringify(got)}`);
}

console.log("src/state/friendlyError.ts");
is("브라우저 fetch 실패", "서버에 연결할 수 없습니다: Failed to fetch", NETWORK);
is("서버 연결 실패 문구 안의 fetch failed 도 연결 끊김", "서버에 연결할 수 없습니다: fetch failed", NETWORK);
is("스트림 읽기 중단", "스트림을 읽는 중 오류가 발생했습니다: network error", NETWORK);
is("Safari 의 Load failed", "Load failed", NETWORK);
is("502 상태", "모델 호출 실패 (502 Bad Gateway)", MODEL_SERVER);
is("503 상태", "요청이 실패했습니다 (503 Service Unavailable)", MODEL_SERVER);
is("504 상태", "upstream returned 504", MODEL_SERVER);
is("모델 서버 문구", "모델 서버에 연결하지 못했습니다. (502 Bad Gateway)", MODEL_SERVER);
is("서버 쪽 ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:8000", MODEL_SERVER);
is("429", "Too Many Requests (429 Too Many Requests)", RATE_LIMITED);
is("401", "Unauthorized (401 Unauthorized)", UNAUTHORIZED);
is("그 밖의 것", "Unknown tool: foo", GENERIC);
is("다른 숫자에는 걸리지 않는다", "도구 호출 4290회 뒤 실패", GENERIC);
is("소수점 숫자에도 걸리지 않는다", "score 0.502 too low", GENERIC);
is("컨텍스트 한도 안내는 서버 문구 그대로", "메시지가 모델의 컨텍스트 한도를 넘습니다. 내용을 나눠서 보내거나 첨부로 올린 뒤 다시 시도해 주세요.", "메시지가 모델의 컨텍스트 한도를 넘습니다. 내용을 나눠서 보내거나 첨부로 올린 뒤 다시 시도해 주세요.");
is("사용자 중지는 오류가 아니다", "답변이 끝나기 전에 중지되었습니다.", null);
is("AbortError 도 오류가 아니다", "AbortError: The user aborted a request.", null);
is("빈 값은 null", "", null);
is("없으면 null", undefined, null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
