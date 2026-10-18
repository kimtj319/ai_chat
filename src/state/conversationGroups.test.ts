// 사이드바 대화 묶음·제목 검색 검사. `npm test` 로 돈다.
//
// 브라우저 타입체크를 받는 src/ 아래이므로 `process` 는 쓰지 않고, 실패는
// throw 로 표시한다(src/routes.test.ts 와 같은 규칙). 날짜는 지역 시각으로 만들어
// 어느 시간대에서 돌려도 같은 결과가 나오게 한다.
import { filterByTitle, groupConversationsByDate, splitMatch } from "./conversationGroups.js";

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failures.push({ name, message: detail });
  }
}

/** 지역 시각 ISO 문자열. */
function at(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

const NOW = new Date(2026, 9, 17, 9, 0); // 2026-10-17 09:00 지역 시각

const items = [
  { id: "a", title: "오늘 아침", createdAt: at(2026, 10, 1), updatedAt: at(2026, 10, 17, 0) },
  { id: "b", title: "어제 밤", createdAt: at(2026, 10, 16, 23), updatedAt: at(2026, 10, 16, 23) },
  { id: "c", title: "사흘 전", createdAt: at(2026, 10, 14), updatedAt: at(2026, 10, 14) },
  { id: "d", title: "이레 전", createdAt: at(2026, 10, 10), updatedAt: at(2026, 10, 10) },
  { id: "e", title: "여드레 전", createdAt: at(2026, 10, 9), updatedAt: at(2026, 10, 9) },
  { id: "f", title: "서른 날 전", createdAt: at(2026, 9, 17), updatedAt: at(2026, 9, 17) },
  { id: "g", title: "8월", createdAt: at(2026, 8, 31), updatedAt: at(2026, 8, 31) },
  { id: "h", title: "작년 12월", createdAt: at(2025, 12, 3), updatedAt: at(2025, 12, 3) },
  { id: "i", title: "8월 둘째", createdAt: at(2026, 8, 2), updatedAt: at(2026, 8, 2) },
];

const groups = groupConversationsByDate(items, NOW);
const shape = groups.map((g) => `${g.label}:${g.items.map((x) => x.id).join("")}`).join(" | ");
check(
  "경계마다 맞는 묶음에, 최근 묶음부터",
  shape === "오늘:a | 어제:b | 지난 7일:cd | 지난 30일:ef | 2026년 8월:gi | 2025년 12월:h",
  shape,
);

// updatedAt 이 없거나 깨졌으면 createdAt 으로 본다.
const fallback = groupConversationsByDate(
  [
    { id: "x", createdAt: at(2026, 10, 16) },
    { id: "y", createdAt: at(2026, 10, 17), updatedAt: "not a date" },
  ],
  NOW,
);
check(
  "updatedAt 이 없으면 createdAt",
  fallback.find((g) => g.label === "어제")?.items[0]?.id === "x",
  JSON.stringify(fallback),
);
check(
  "updatedAt 이 깨졌으면 createdAt",
  fallback.find((g) => g.label === "오늘")?.items[0]?.id === "y",
  JSON.stringify(fallback),
);
check("미래 시각은 오늘로", groupConversationsByDate([{ createdAt: at(2026, 10, 18) }], NOW)[0]?.label === "오늘");
check("빈 목록은 묶음도 없다", groupConversationsByDate([], NOW).length === 0);

// 입력 순서가 섞여 있어도 묶음은 한 번씩만, 묶음 안 순서는 입력 순서.
const shuffled = groupConversationsByDate([items[2]!, items[0]!, items[3]!], NOW);
check(
  "섞인 입력도 묶음은 한 번씩",
  shuffled.map((g) => `${g.label}:${g.items.map((x) => x.id).join("")}`).join(" | ") === "오늘:a | 지난 7일:cd",
);

// 고정한 대화: 날짜와 상관없이 맨 위 "고정됨" 한 묶음에, 날짜 묶음에서는 빠진다.
const withPins = groupConversationsByDate(
  [
    { ...items[0]!, pinned: false },
    { ...items[6]!, pinned: true },
    items[1]!,
    { ...items[2]!, pinned: true },
  ],
  NOW,
);
const pinShape = withPins.map((g) => `${g.key}/${g.label}:${g.items.map((x) => x.id).join("")}`).join(" | ");
check(
  "고정됨이 맨 위, 고정한 것은 날짜 묶음에 다시 나오지 않는다",
  pinShape === "pinned/고정됨:gc | today/오늘:a | yesterday/어제:b",
  pinShape,
);
check(
  "고정한 것이 없으면 고정됨 묶음도 없다",
  !groupConversationsByDate(items, NOW).some((g) => g.key === "pinned"),
);
check(
  "고정한 것만 있어도 된다",
  groupConversationsByDate([{ ...items[7]!, pinned: true }], NOW).map((g) => g.label).join() === "고정됨",
);

// 제목 검색
const titled = [{ title: "Qwen 설정 질문" }, { title: "회의록 정리" }, { title: "qwen 벤치마크" }];
check("대소문자 무시", filterByTitle(titled, "QWEN").length === 2);
check("빈 검색어는 전부", filterByTitle(titled, "  ").length === 3);
check("없는 말은 0건", filterByTitle(titled, "없는말").length === 0);
check("앞뒤 공백은 무시", filterByTitle(titled, " 회의록 ").length === 1);

const parts = splitMatch("Qwen 설정 질문", "qwen");
check("일치 부분은 원문 대소문자로", JSON.stringify(parts) === JSON.stringify(["", "Qwen", " 설정 질문"]), JSON.stringify(parts));
check("가운데 일치", JSON.stringify(splitMatch("회의록 정리", "정")) === JSON.stringify(["회의록 ", "정", "리"]));
check("일치 없으면 null", splitMatch("회의록", "x") === null);
check("빈 검색어면 null", splitMatch("회의록", "") === null);

console.log("src/state/conversationGroups.ts");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  throw new Error(`${failures.length} check(s) failed`);
}
