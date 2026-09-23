// server/mcp/ownerPrefs.ts 검사. `npx tsx server/mcp/ownerPrefs.test.ts` 로 돈다.
// (package.json 의 test 스크립트에는 아직 엮지 않았다.)
//
// 이 파일이 보려는 것은 세 가지다.
//
//   1. 옛 mcp.json(`optedOutBuiltins`)이 새 코드에서도 그대로 동작하는가 —
//      마이그레이션 스크립트 없이, 읽을 때 `hidden` 으로 합쳐지는가.
//   2. 다음 쓰기가 새 모양(`hidden`)으로 저장되는가 — 옛 필드 이름이 파일에
//      남아 있으면 안 된다.
//   3. setHidden 이 끈 서버가 effectiveServers(=도구 조립의 문)에서 실제로
//      빠지는가, forgetServerEverywhere 가 hidden 도 함께 지우는가.
//
// rulesParity.test.ts 는 effectiveServers 의 판정식 자체를 프런트와 맞대어
// 보므로, 여기서는 그 식을 다시 표로 돌리지 않는다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-owner-prefs-test-"));
process.env.DATA_DIR = dataDir;

// config.ts 가 모듈 로드 시점에 DATA_DIR 을 읽으므로, 위에서 env 를 바꾼
// 뒤에 동적 import 로 가져와야 한다(board.test.ts 와 같은 이유).
const { readOwnerPrefs, setAdoption, setHidden, effectiveServers, forgetServerEverywhere } = await import(
  "./ownerPrefs.js"
);
const { ownerMcpFile } = await import("../storage/paths.js");
const { writeJsonFileAtomic } = await import("../storage/atomic.js");

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

console.log("server/mcp/ownerPrefs.ts");

/* ------------------------------------------------- 옛 파일 호환 (읽기) */

{
  // hidden 이 생기기 전에 저장된 모양 그대로: optedOutBuiltins 만 있고 hidden
  // 은 아예 없다.
  await writeJsonFileAtomic(ownerMcpFile("legacy-user"), {
    adopted: ["shared-1"],
    optedOutBuiltins: ["builtin-a", "builtin-b"],
    credentials: { "shared-1": "secret" },
  });

  const prefs = await readOwnerPrefs("legacy-user");
  check("adopted 는 그대로 읽힌다", prefs.adopted.join(",") === "shared-1", prefs.adopted.join(","));
  check(
    "옛 optedOutBuiltins 가 hidden 으로 합쳐져 읽힌다",
    [...prefs.hidden].sort().join(",") === "builtin-a,builtin-b",
    [...prefs.hidden].sort().join(","),
  );
  check("credentials 도 그대로 읽힌다", prefs.credentials["shared-1"] === "secret", JSON.stringify(prefs.credentials));
}

/* ------------------------------------------------ 옛 파일 호환 (다음 쓰기) */

{
  // 방금 읽은 legacy-user 를 스위치 하나 건드려서 다시 쓴다 — 그 순간부터는
  // 새 모양으로 저장되어야 한다(마이그레이션 스크립트 없이, 쓰기 경로에서
  // 자연히 새 모양이 된다).
  await setHidden("legacy-user", "builtin-a", false);

  const raw = JSON.parse(await fs.readFile(ownerMcpFile("legacy-user"), "utf8")) as Record<string, unknown>;
  check("다시 쓴 파일에는 옛 필드 이름이 없다", !("optedOutBuiltins" in raw), JSON.stringify(raw));
  check("다시 쓴 파일은 hidden 배열을 갖는다", Array.isArray(raw.hidden), JSON.stringify(raw));
  check(
    "켠 것(builtin-a)은 빠지고 나머지(builtin-b)는 남는다",
    (raw.hidden as string[]).join(",") === "builtin-b",
    JSON.stringify(raw.hidden),
  );
}

/* --------------------------------------------------------- setHidden */

{
  const prefs = await setHidden("alice", "srv-1", true);
  check("hidden 에 추가된다", prefs.hidden.includes("srv-1"), JSON.stringify(prefs.hidden));

  const again = await setHidden("alice", "srv-1", true);
  check("두 번 꺼도 한 번만 들어간다(Set)", again.hidden.filter((id) => id === "srv-1").length === 1);

  const back = await setHidden("alice", "srv-1", false);
  check("다시 켜면 hidden 에서 빠진다", !back.hidden.includes("srv-1"), JSON.stringify(back.hidden));
}

/* ------------------------------------------------------- setAdoption */

{
  const prefs = await setAdoption(
    "bob",
    { id: "srv-2", origin: "user" } as never,
    true,
  );
  check("adopted 에 추가된다", prefs.adopted.includes("srv-2"), JSON.stringify(prefs.adopted));
  check("hidden 은 건드리지 않는다", prefs.hidden.length === 0, JSON.stringify(prefs.hidden));
}

/* -------------------------------------------- effectiveServers 와 실제 연동 */

{
  // hand-built prefs 가 아니라, 실제 setAdoption/setHidden 을 거친 결과로
  // 확인한다 — 판정식 자체는 rulesParity.test.ts 가 이미 표로 돈다.
  const server = {
    id: "srv-3",
    origin: "user",
    status: "active",
    createdBy: "someone-else",
  } as never;

  await setAdoption("carol", server, true);
  let prefs = await readOwnerPrefs("carol");
  check("채택하면 도구 조립 대상에 들어간다", effectiveServers([server], prefs, "carol").length === 1);

  await setHidden("carol", "srv-3", true);
  prefs = await readOwnerPrefs("carol");
  check("꺼두면 채택된 상태여도 도구 조립에서 빠진다", effectiveServers([server], prefs, "carol").length === 0);
}

/* -------------------------------------------------- forgetServerEverywhere */

{
  await setAdoption("dave", { id: "srv-4", origin: "user" } as never, true);
  await setHidden("dave", "srv-4", true);
  let prefs = await readOwnerPrefs("dave");
  check("지우기 전: adopted 와 hidden 모두에 있다", prefs.adopted.includes("srv-4") && prefs.hidden.includes("srv-4"));

  const touched = await forgetServerEverywhere("srv-4");
  check("건드린 소유자 수를 센다", touched >= 1, String(touched));

  prefs = await readOwnerPrefs("dave");
  check("삭제된 서버는 adopted 에서도 빠진다", !prefs.adopted.includes("srv-4"));
  check("삭제된 서버는 hidden 에서도 빠진다", !prefs.hidden.includes("srv-4"));
}

/* ------------------------------------------------------- 남의 파일은 그대로 */

{
  const before = await readOwnerPrefs("eve");
  check("건드리지 않은 계정은 처음부터 비어 있다", before.adopted.length === 0 && before.hidden.length === 0);

  await setHidden("frank", "srv-5", true);
  const eve = await readOwnerPrefs("eve");
  check("남의 계정에 스위치를 걸어도 eve 의 파일은 그대로다", eve.adopted.length === 0 && eve.hidden.length === 0);
}

await fs.rm(dataDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
