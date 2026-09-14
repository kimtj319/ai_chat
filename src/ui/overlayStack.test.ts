// 떠 있는 것 세기 검사. `npm test` 로 돈다.
//
// 이 숫자가 틀리면 Esc 가 엉뚱한 일을 한다. 0 이어야 할 때 1 이면 생성을
// 멈출 수 없고, 1 이어야 할 때 0 이면 답변을 기다리다 모달을 닫는 순간
// 답변이 끊긴다. 둘 다 오류 없이 조용히 틀린다.
import { overlayOpen, pushOverlay, resetOverlayStack } from "./overlayStack.js";

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

console.log("src/ui/overlayStack.ts");

resetOverlayStack();
check("처음에는 아무것도 떠 있지 않다", !overlayOpen());

{
  const close = pushOverlay();
  check("하나 떠오르면 열린 상태", overlayOpen());
  close();
  check("내려가면 닫힌 상태", !overlayOpen());
}

{
  // 모달 위의 확인 대화상자. 위의 것을 닫아도 아래가 남아 있으면 Esc 는
  // 여전히 그 몫이다.
  const outer = pushOverlay();
  const inner = pushOverlay();
  check("겹쳐 떠 있어도 열린 상태", overlayOpen());
  inner();
  check("위의 것만 닫으면 아직 열려 있다", overlayOpen());
  outer();
  check("둘 다 닫히면 비로소 닫힌다", !overlayOpen());
}

{
  // React 18 StrictMode 는 effect 를 일부러 두 번 돌린다. 해제가 두 번 불려도
  // 셈이 음수로 내려가면 안 된다 — 음수가 되면 정말 떠 있을 때도 0 이 되어
  // Esc 가 모달을 닫으면서 생성까지 멈춘다.
  const close = pushOverlay();
  close();
  close();
  check("같은 해제를 두 번 불러도 셈이 새지 않는다", !overlayOpen());
  const other = pushOverlay();
  check("  그 뒤에 뜬 것은 제대로 세어진다", overlayOpen());
  other();
  check("  그리고 제대로 내려간다", !overlayOpen());
}

{
  // 순서가 뒤섞여 닫히는 경우. 아래 것이 먼저 닫혀도 셈은 맞아야 한다.
  const a = pushOverlay();
  const b = pushOverlay();
  a();
  check("아래 것이 먼저 닫혀도 아직 열려 있다", overlayOpen());
  b();
  check("나머지가 닫히면 닫힌다", !overlayOpen());
}

resetOverlayStack();

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  // routes.test.ts 와 같은 이유로 던진다: 이 파일도 브라우저용 타입 체크를 받는다.
  throw new Error(`${failures.length}건 실패`);
}
