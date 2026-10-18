// PageUp·PageDown·Home·End 를 어디로 보낼지의 규칙. `npm test` 로 돈다.
//
// 브라우저 타입체크를 받는 src/ 아래라 `process` 는 쓰지 않고, 실패는 throw 로 알린다.
import { pageDistance, scrollKeyAction, scrollTarget, type ScrollKeyInput } from "./scrollKeys.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: unknown): void {
  if (condition) passed++;
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

function input(over: Partial<ScrollKeyInput>): ScrollKeyInput {
  return {
    key: "PageDown",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    isComposing: false,
    focus: "other",
    composerScrollable: false,
    ...over,
  };
}

console.log("src/state/scrollKeys.ts");

check("body 의 PageDown 은 한 화면 아래", JSON.stringify(scrollKeyAction(input({}))) === JSON.stringify({ kind: "page", direction: 1 }));
check("body 의 PageUp 은 한 화면 위", JSON.stringify(scrollKeyAction(input({ key: "PageUp" }))) === JSON.stringify({ kind: "page", direction: -1 }));
check("body 의 Home 은 맨 위", JSON.stringify(scrollKeyAction(input({ key: "Home" }))) === JSON.stringify({ kind: "edge", edge: "start" }));
check("body 의 End 는 맨 아래", JSON.stringify(scrollKeyAction(input({ key: "End" }))) === JSON.stringify({ kind: "edge", edge: "end" }));
check("다른 키는 모른다", scrollKeyAction(input({ key: "ArrowDown" })) === null && scrollKeyAction(input({ key: "Escape" })) === null);

for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
  for (const key of ["PageDown", "PageUp", "Home", "End"]) {
    check(`${mod}+${key} 는 브라우저 몫`, scrollKeyAction(input({ key, [mod]: true })) === null);
  }
}
check("이미 처리된 키는 건드리지 않는다", scrollKeyAction(input({ defaultPrevented: true })) === null);
check("한글 조합 중에는 건드리지 않는다", scrollKeyAction(input({ isComposing: true })) === null);

for (const key of ["PageDown", "PageUp", "Home", "End"]) {
  check(`다른 글 칸의 ${key} 는 그 칸 몫`, scrollKeyAction(input({ key, focus: "editable" })) === null);
  check(`메뉴·대화상자의 ${key} 는 그 몫`, scrollKeyAction(input({ key, focus: "widget" })) === null);
}

check("빈 입력창의 PageDown 은 본문을 넘긴다", scrollKeyAction(input({ focus: "composer" }))?.kind === "page");
check("빈 입력창의 PageUp 도", scrollKeyAction(input({ key: "PageUp", focus: "composer" }))?.kind === "page");
check("입력창의 Home 은 커서 옮기기", scrollKeyAction(input({ key: "Home", focus: "composer" })) === null);
check("입력창의 End 도", scrollKeyAction(input({ key: "End", focus: "composer" })) === null);
check("넘치게 쓴 입력창의 PageDown 은 입력창 몫", scrollKeyAction(input({ focus: "composer", composerScrollable: true })) === null);
check("입력창의 Shift+PageDown 은 고르기", scrollKeyAction(input({ focus: "composer", shiftKey: true })) === null);
check("본문의 Shift+PageDown 은 넘긴다", scrollKeyAction(input({ shiftKey: true }))?.kind === "page");

check("창이 닫혀 있으면 본문", scrollTarget({ open: false, covers: false }, "panel") === "chat");
check("창이 열려 있어도 마지막에 본문을 만졌으면 본문", scrollTarget({ open: true, covers: false }, "chat") === "chat");
check("아무 데도 안 만졌으면 본문", scrollTarget({ open: true, covers: false }, null) === "chat");
check("마지막에 창을 만졌으면 창", scrollTarget({ open: true, covers: false }, "panel") === "panel");
check("창이 화면을 덮으면 늘 창", scrollTarget({ open: true, covers: true }, "chat") === "panel");

check("한 화면은 보이는 높이의 90%", pageDistance(700) === 630);
check("아주 낮아도 조금은 넘긴다", pageDistance(10) === 40);

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) throw new Error(`${failures.length}건 실패`);
