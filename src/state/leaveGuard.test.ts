// 화면을 떠나기 전 확인(대화 설정의 적용하지 않은 변경). `npm test` 로 돈다.
import { leaveVia, setLeaveGuard } from "./leaveGuard.js";

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

console.log("src/state/leaveGuard.ts");

let moved = 0;
const move = () => {
  moved++;
};

leaveVia(move);
check("걸린 것이 없으면 곧장 떠난다", moved === 1);

let asked: (() => void) | null = null;
const remove = setLeaveGuard((proceed) => {
  asked = proceed;
});
leaveVia(move);
check("걸려 있으면 떠나지 않고 묻는다", moved === 1 && asked !== null);
asked!();
check("물은 쪽이 허락하면 그때 떠난다", moved === 2);

remove();
leaveVia(move);
check("걷어 내면 다시 곧장 떠난다", moved === 3);

// 대화를 바꾸면 설정 화면이 새로 그려진다: 앞 화면의 걷기가 뒤 화면이 건 것을 지우면 안 된다.
const removeOld = setLeaveGuard(() => {});
let newAsked = false;
setLeaveGuard(() => {
  newAsked = true;
});
removeOld();
leaveVia(move);
check("남이 건 것은 걷지 않는다", newAsked && moved === 3);
setLeaveGuard(null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
