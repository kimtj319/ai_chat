// 화면에 보이는 오류 한 줄(errorMessage)에서 HTTP 상태 꼬리를 떼는 규칙. `npm test` 로 돈다.
// (답변 오류 카드의 friendlyError 는 friendlyError.test.ts 가 본다 — 그쪽은 원문의 상태 번호로 가른다.)
import { errorMessage, isNotFoundError } from "./friendlyError.js";

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

function shows(name: string, raw: string, expected: string): void {
  const got = errorMessage(new Error(raw));
  check(name, got === expected, `got ${JSON.stringify(got)}`);
}

console.log("src/state/friendlyError.ts — errorMessage");
// src/api/http.ts extractErrorMessage 가 만드는 모양 그대로.
shows("서버 문장 뒤의 404 꼬리를 뗀다", "존재하지 않는 글입니다. (404 Not Found)", "존재하지 않는 글입니다.");
shows("공유 링크 404", "공유된 대화를 찾을 수 없습니다. (404 Not Found)", "공유된 대화를 찾을 수 없습니다.");
shows("400 도 같다", "제목을 입력해 주세요. (400 Bad Request)", "제목을 입력해 주세요.");
shows("상태 글이 없는 꼬리도", "권한이 없습니다. (403)", "권한이 없습니다.");
// 서버가 문장을 주지 않았으면 상태가 유일한 단서다 — 남긴다.
shows("문장이 없으면 그대로", "요청이 실패했습니다 (500 Internal Server Error)", "요청이 실패했습니다 (500 Internal Server Error)");
shows("가운데 괄호는 건드리지 않는다", "이름(필수)을 입력해 주세요.", "이름(필수)을 입력해 주세요.");
shows("세 자리 숫자가 아닌 꼬리도 그대로", "문서 3개를 올렸습니다 (2건 실패)", "문서 3개를 올렸습니다 (2건 실패)");
check("Error 가 아닌 것도 문자열로", errorMessage("그냥 문자열 (404 Not Found)") === "그냥 문자열");

check("404 는 '없음'", isNotFoundError(new Error("존재하지 않는 글입니다. (404 Not Found)")));
check("410 도 '없음'", isNotFoundError(new Error("만료된 링크입니다. (410 Gone)")));
check("500 은 '없음' 이 아니다", !isNotFoundError(new Error("요청이 실패했습니다 (500 Internal Server Error)")));
check("상태가 없으면 '없음' 이 아니다", !isNotFoundError(new Error("서버에 연결할 수 없습니다: Failed to fetch")));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
