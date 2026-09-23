// MCP 가시성 규칙 일치 검사. `npx tsx server/mcp/rulesParity.test.ts` 로 돈다.
// (package.json 의 test 스크립트에는 아직 엮지 않았다 — 아래 실행 방법 그대로
// 수동으로 돌리거나, 엮기로 하면 이 줄 그대로 추가하면 된다.)
//
// 프런트(src/mcp/rules.ts `isMcpVisible`)와 서버(server/mcp/ownerPrefs.ts
// `effectiveServers`)가 "이 서버의 도구가 피커에 보이는가 / 모델에게 가는가"를
// 각자 따로 판정한다. 한쪽은 브라우저에서, 한쪽은 Node 에서 도니 코드를 공유할
// 수 없어 규칙을 양쪽에 똑같이 적어 두는 수밖에 없는데, 그러면 언젠가 한쪽만
// 고치는 실수가 난다 — 실제로 이번 작업의 발단이 그거였다: 내가 등록한 서버의
// 채택을 해제하면 프런트는 여전히 보여주는데(createdBy===me 라 무조건 보임)
// 서버는 도구를 끊었다(adopted 에 없다는 이유로).
//
// 그래서 이 파일은 입력 조합을 전부 돌며 세 가지를 강제한다: 서버 구현이
// 명세와 같다, 프런트 구현이 명세와 같다, 그리고 — 이게 핵심 — 둘이 항상 같은
// 답을 낸다. 어느 한 줄이라도 갈라지면 실패한다.
import { effectiveServers } from "./ownerPrefs.js";
import { isMcpVisible } from "../../src/mcp/rules.js";
import type { McpServerRecord, OwnerMcpPrefs } from "../types.js";

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

const ME = "me";
const OTHER = "other";
const SERVER_ID = "s1";

function fixture(origin: "builtin" | "user", createdBy: string, status: "active" | "disabled"): McpServerRecord {
  return {
    id: SERVER_ID,
    name: "검사용",
    slug: "test",
    description: "검사용 서버",
    transport: "http",
    url: "https://example.com/mcp",
    origin,
    status,
    authMode: "none",
    timeoutMs: 8000,
    createdBy,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as McpServerRecord;
}

console.log("src/mcp/rules.ts isMcpVisible <-> server/mcp/ownerPrefs.ts effectiveServers");

const BOOL = [false, true];
let combos = 0;
for (const isBuiltin of BOOL) {
  for (const isOwn of BOOL) {
    for (const isActive of BOOL) {
      for (const isAdopted of BOOL) {
        for (const isHidden of BOOL) {
          combos++;
          const origin = isBuiltin ? "builtin" : "user";
          const createdBy = isOwn ? ME : OTHER;
          const status = isActive ? "active" : "disabled";
          const server = fixture(origin, createdBy, status);
          const prefs: OwnerMcpPrefs = {
            adopted: isAdopted ? [SERVER_ID] : [],
            hidden: isHidden ? [SERVER_ID] : [],
            credentials: {},
          };

          // 명세를 코드 밖에서 그대로 옮긴 것. 최종 가시성 규칙:
          // 활성 && (기본 제공 || 내가 등록 || 채택함) && !숨김.
          const expected = isActive && (isBuiltin || isOwn || isAdopted) && !isHidden;

          const serverResult = effectiveServers([server], prefs, ME).some((s) => s.id === SERVER_ID);
          const frontResult = isMcpVisible(server, prefs.adopted, prefs.hidden, ME);

          const label = `builtin=${isBuiltin} own=${isOwn} active=${isActive} adopted=${isAdopted} hidden=${isHidden}`;
          check(`서버 규칙이 명세와 같다: ${label}`, serverResult === expected, `got ${serverResult}`);
          check(`프런트 규칙이 명세와 같다: ${label}`, frontResult === expected, `got ${frontResult}`);
          check(`서버와 프런트가 서로 같다: ${label}`, serverResult === frontResult, `server=${serverResult} front=${frontResult}`);
        }
      }
    }
  }
}
check(`32개 조합을 전부 돌았다`, combos === 32, String(combos));

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
