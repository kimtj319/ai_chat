// "지금 답변하기" 버튼 표시 규칙 검사. `npx tsx src/state/answerNow.test.ts` 로 돈다.
// (server 쪽 계약 검사와 나란히 있지만 npm test 스크립트에는 아직 없다 — 손으로
// 이 경로를 불러서 확인한다.)
//
// 브라우저 타입체크를 받는 src/ 아래이므로 `process` 는 쓰지 않고, 실패는
// throw 로 표시한다(src/routes.test.ts 와 같은 규칙).
import { shouldShowAnswerNowButton, type AnswerNowVisibilityInput } from "./answerNow.js";

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failures.push({ name, message: detail });
  }
}

const BASE: AnswerNowVisibilityInput = {
  isStreaming: true,
  turnStartedAt: 0,
  answerNowAfterMs: 180_000,
  clicked: false,
  answerStreaming: false,
  now: 180_000,
};

check("경과가 임계값과 정확히 같으면 뜬다(이상, 초과 아님)", shouldShowAnswerNowButton(BASE) === true);

check(
  "임계값 1ms 못 미치면 안 뜬다",
  shouldShowAnswerNowButton({ ...BASE, now: 179_999 }) === false,
);

check(
  "임계값을 한참 넘겨도 뜬다",
  shouldShowAnswerNowButton({ ...BASE, now: 10 * 60_000 }) === true,
);

check(
  "스트리밍 중이 아니면 아무리 지나도 안 뜬다",
  shouldShowAnswerNowButton({ ...BASE, isStreaming: false, now: 999_999 }) === false,
);

check(
  "이미 눌렀으면 안 뜬다(경과와 무관)",
  shouldShowAnswerNowButton({ ...BASE, clicked: true, now: 999_999 }) === false,
);

check(
  "turn_started 가 아직 안 왔으면(null) 안 뜬다",
  shouldShowAnswerNowButton({ ...BASE, turnStartedAt: null, now: 999_999 }) === false,
);

check(
  "턴 시작 시각이 기준이다 — now 가 아니라 (now - turnStartedAt) 이 임계값과 비교된다",
  shouldShowAnswerNowButton({ ...BASE, turnStartedAt: 1_000_000, now: 1_000_000 + 180_000 }) === true &&
    shouldShowAnswerNowButton({ ...BASE, turnStartedAt: 1_000_000, now: 1_000_000 + 179_999 }) === false,
);

check(
  "임계값이 짧게 설정되면 그만큼 일찍 뜬다",
  shouldShowAnswerNowButton({ ...BASE, answerNowAfterMs: 1000, now: 1000 }) === true &&
    shouldShowAnswerNowButton({ ...BASE, answerNowAfterMs: 1000, now: 999 }) === false,
);

// 사용자 요구: "기다려서 답변이 출력되면 버튼이 없어져야 한다". 답이 흘러나오는
// 도중에 누르면 마무리 답변이 이미 나온 조각 뒤에 이어 붙어 두 조각이 된다.
check(
  "답변 글자가 흘러나오는 중이면 3분이 지났어도 뜨지 않는다",
  shouldShowAnswerNowButton({ ...BASE, now: 10 * 60_000, answerStreaming: true }) === false,
);
// 도구 사이의 짧은 말 뒤에 다시 도구를 부르러 가면 훅이 answerStreaming 을
// 거짓으로 돌린다 — 그때 버튼이 되살아나야 한다.
check(
  "다시 일하러 가면(answerStreaming 거짓) 되살아난다",
  shouldShowAnswerNowButton({ ...BASE, now: 10 * 60_000, answerStreaming: false }) === true,
);

console.log("src/state/answerNow.ts");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  throw new Error(`${failures.length} check(s) failed`);
}
