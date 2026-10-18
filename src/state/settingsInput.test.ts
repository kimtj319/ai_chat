// 대화 설정의 Max Tokens 칸 검사. `npm test` 로 돈다.
//
// 화면의 안내(1,024–65,536)와 서버 검사(server/settings.ts)가 다른 범위를 말하던 것이
// 발단이다 — 화면은 99 를 막지 않았고 서버는 1 부터 받아 99 가 그대로 저장됐다.
// 이 파일은 둘이 같은 범위를 쓰는지, 그리고 칸에 적힌 글자를 어떻게 읽는지를 본다.
import { parseMaxTokens } from "./settingsInput.js";
import { MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "./defaults.js";
import { DEFAULT_SETTINGS, validateSettingsPatch } from "../../server/settings.js";

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

console.log("src/state/settingsInput.ts + server/settings.ts — Max Tokens");

check("화면의 하한이 1,024", MIN_MAX_TOKENS === 1024, String(MIN_MAX_TOKENS));
check("화면의 상한이 65,536", MAX_MAX_TOKENS === 65536, String(MAX_MAX_TOKENS));

const server = (value: unknown) => validateSettingsPatch({ maxTokens: value });
check("서버도 하한 아래(99)를 거절한다", !server(99).ok);
check("서버도 하한 바로 아래(1,023)를 거절한다", !server(MIN_MAX_TOKENS - 1).ok);
check("서버는 하한(1,024)을 받는다", server(MIN_MAX_TOKENS).ok);
check("서버는 상한(65,536)을 받는다", server(MAX_MAX_TOKENS).ok);
check("서버는 상한 위를 거절한다", !server(MAX_MAX_TOKENS + 1).ok);

const ok = (raw: string, value: number) => {
  const got = parseMaxTokens(raw);
  check(`"${raw}" → ${value}`, got.ok && got.value === value, JSON.stringify(got));
};
const bad = (raw: string) => {
  const got = parseMaxTokens(raw);
  check(`"${raw}" 는 오류`, !got.ok && got.message.length > 0, JSON.stringify(got));
};
ok("2048", 2048);
ok(" 4096 ", 4096);
ok(String(MIN_MAX_TOKENS), MIN_MAX_TOKENS);
ok(String(MAX_MAX_TOKENS), MAX_MAX_TOKENS);
// 비운 칸은 Seed 처럼 "기본값" 이다. 예전에는 Number("") = 0 이 상태에 들어가 서버에서 실패했다.
ok("", DEFAULT_SETTINGS.maxTokens);
ok("   ", DEFAULT_SETTINGS.maxTokens);
bad("99");
bad(String(MIN_MAX_TOKENS - 1));
bad(String(MAX_MAX_TOKENS + 1));
bad("2048.5");
bad("abc");
bad("1e3");

// 화면이 통과시키는 값은 서버도 통과시킨다 — 둘이 갈라지면 적용을 눌렀을 때에야 실패한다.
for (const raw of ["", "1024", "16384", "65536"]) {
  const got = parseMaxTokens(raw);
  check(`"${raw}" 는 서버도 받는다`, got.ok && server(got.value).ok);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
