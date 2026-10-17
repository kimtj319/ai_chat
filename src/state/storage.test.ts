// 화면 설정 저장소 검사: localStorage 접근 자체가 막힌 브라우저에서도 앱이
// 기본값으로 뜨는지. `npx tsx src/state/storage.test.ts` 로 돈다.
import { createDefaultUiPreferences } from "./defaults";
import { loadUiPreferences, saveUiPreferences } from "./storage";

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

function withStorage(storage: Partial<Storage>, body: () => void): void {
  const holder = globalThis as { localStorage?: unknown };
  const before = holder.localStorage;
  holder.localStorage = storage;
  try {
    body();
  } finally {
    holder.localStorage = before;
  }
}

function attempt(work: () => unknown): { value?: unknown; error?: unknown } {
  try {
    return { value: work() };
  } catch (error) {
    return { error };
  }
}

console.log("src/state/storage.ts");

const blocked: Partial<Storage> = {
  getItem: () => {
    throw new Error("SecurityError: The operation is insecure.");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

withStorage(blocked, () => {
  const loaded = attempt(() => loadUiPreferences());
  check("getItem 이 던져도 읽기는 던지지 않는다", loaded.error === undefined, String(loaded.error));
  check(
    "getItem 이 던지면 기본값",
    JSON.stringify(loaded.value) === JSON.stringify(createDefaultUiPreferences()),
  );
  const saved = attempt(() => saveUiPreferences(createDefaultUiPreferences()));
  check("setItem 이 던져도 저장은 던지지 않는다", saved.error === undefined, String(saved.error));
});

const stored = new Map<string, string>();
withStorage(
  { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) },
  () => {
    saveUiPreferences({ ...createDefaultUiPreferences(), theme: "dark" });
    check("정상 저장소에서는 저장한 값을 읽는다", loadUiPreferences().theme === "dark");
  },
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
