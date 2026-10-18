// 대화마다 따로 두는 입력창 초안 검사. `npx tsx src/state/composerDraft.test.ts` 로 돈다.
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

// 브라우저의 sessionStorage 를 흉내 낸다(이 검사는 Node 에서 돈다).
const stored = new Map<string, string>();
let storageThrows = false;
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (key: string) => {
    if (storageThrows) throw new Error("blocked");
    return stored.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (storageThrows) throw new Error("blocked");
    stored.set(key, value);
  },
  removeItem: (key: string) => {
    if (storageThrows) throw new Error("blocked");
    stored.delete(key);
  },
};

const { readDraft, writeDraft, forgetDraftsInMemory } = await import("./composerDraft.js");

console.log("src/state/composerDraft.ts");

check("처음에는 비어 있다", readDraft("A") === "");
writeDraft("A", "초안: 아직 안 보낸 긴 질문");
writeDraft("B", "다른 대화의 초안");
check("대화마다 따로 남는다", readDraft("A") === "초안: 아직 안 보낸 긴 질문" && readDraft("B") === "다른 대화의 초안");

// 새로 고침: 메모리는 비고 sessionStorage 만 남는다.
forgetDraftsInMemory();
check("새로 고쳐도 sessionStorage 에서 되살아난다", readDraft("A") === "초안: 아직 안 보낸 긴 질문");

writeDraft("A", "");
check("보내면(빈 글) 지운다", readDraft("A") === "" && !stored.has("composer-draft:A"));
check("  └ 다른 대화의 초안은 그대로다", readDraft("B") === "다른 대화의 초안");

// 사생활 보호 창처럼 저장소가 막혀 있어도 이 탭 안에서는 남는다.
storageThrows = true;
writeDraft("C", "막힌 저장소");
check("저장소가 막혀도 메모리에는 남는다", readDraft("C") === "막힌 저장소");
storageThrows = false;

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
