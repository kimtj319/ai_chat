// 통째로 다시 쓰는 저장소 검사. `npx tsx server/storage/ownerStores.test.ts` 로 돈다.
//
// 지키는 것은 둘이다.
//   1. 읽다가 실패하면 쓰지 않는다. 모델 등록자·개인 키·예약은 파일 하나를 읽어
//      고친 뒤 통째로 다시 쓴다. 읽기 실패(깨진 JSON, 권한, 열린 파일 수 초과)를
//      "빈 파일" 로 보고 계속하면, 새 항목 하나만 담긴 파일이 나머지를 덮어 버린다 —
//      model-owners.json 은 모든 계정이 함께 쓰는 파일이다.
//   2. 계정을 지우면 그 계정이 등록한 모델 엔드포인트의 등록자 기록도 지운다. 남겨
//      두면 같은 id 로 다시 가입한 사람이 그 엔드포인트를 쓰고 지울 수 있다.
//
// config 는 불러들일 때 DATA_DIR 을 읽으므로 import 보다 먼저 세운다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "owner-stores-test-"));
process.env.DATA_DIR = root;
delete process.env.RAG_ENGINE_URL;

const { modelOwnersFile, ownerKeysFile, ownerSchedulesFile } = await import("./paths.js");
const { readModelOwners, removeModelOwner, setModelOwner } = await import("./modelOwners.js");
const { deletePersonalKey, personalKeySummary, setPersonalKey } = await import("./personalKeys.js");
const { createSchedule, listSchedules, updateSchedule } = await import("./scheduleStore.js");
const { deleteOwnerData } = await import("./ownerData.js");

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

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const CORRUPT = "{ not json";

console.log("server/storage — read-modify-write stores");

/* ------------------------------------------------------------ 모델 등록자 */

{
  await setModelOwner("http://a/v1", "alice");
  await fs.writeFile(modelOwnersFile(), CORRUPT);
  check("등록자 파일을 못 읽으면 새 등록이 실패한다", await rejects(() => setModelOwner("http://b/v1", "bob")));
  check("등록자 파일을 못 읽으면 지우기도 실패한다", await rejects(() => removeModelOwner("http://a/v1")));
  check("  └ 파일은 덮어쓰지 않았다", (await fs.readFile(modelOwnersFile(), "utf8")) === CORRUPT);
  check("화면용 읽기는 여전히 빈 것으로 넘어간다", Object.keys(await readModelOwners()).length === 0);
  await fs.rm(modelOwnersFile());
}

/* --------------------------------------------------------------- 개인 키 */

{
  await setPersonalKey("alice", "tavily", "tvly-12345678");
  await fs.writeFile(ownerKeysFile("alice"), CORRUPT);
  check("키 파일을 못 읽으면 새 키 등록이 실패한다", await rejects(() => setPersonalKey("alice", "gitlab", "glpat-12345678")));
  check("키 파일을 못 읽으면 지우기도 실패한다", await rejects(() => deletePersonalKey("alice", "tavily")));
  check("  └ 파일은 덮어쓰지 않았다", (await fs.readFile(ownerKeysFile("alice"), "utf8")) === CORRUPT);
  const summary = await personalKeySummary("alice");
  check("화면용 요약은 여전히 '없음' 으로 넘어간다", summary.tavily.set === false);
}

/* ------------------------------------------------------------------ 예약 */

{
  const first = await createSchedule("alice", {
    conversationId: "c1",
    instruction: "보고서 정리",
    runAt: new Date(Date.now() + 60_000),
    useBrowser: false,
  });
  await fs.writeFile(ownerSchedulesFile("alice"), CORRUPT);
  check(
    "예약 파일을 못 읽으면 새 예약이 실패한다",
    await rejects(() =>
      createSchedule("alice", { conversationId: "c1", instruction: "또", runAt: new Date(), useBrowser: false }),
    ),
  );
  check(
    "예약 파일을 못 읽으면 고치기도 실패한다",
    await rejects(() => updateSchedule("alice", first.id, (t) => ({ ...t, status: "cancelled" }))),
  );
  check("  └ 파일은 덮어쓰지 않았다", (await fs.readFile(ownerSchedulesFile("alice"), "utf8")) === CORRUPT);
  check("목록 읽기는 여전히 빈 목록으로 넘어간다", (await listSchedules("alice")).length === 0);
}

/* ---------------------------------------------- 계정 삭제와 모델 등록자 */

{
  await setModelOwner("http://carol-1/v1", "carol");
  await setModelOwner("http://carol-2/v1", "carol");
  await setModelOwner("http://dave/v1", "dave");
  await deleteOwnerData("carol");
  const owners = await readModelOwners();
  check(
    "계정을 지우면 그 계정의 등록자 기록이 사라진다",
    !Object.values(owners).includes("carol"),
    JSON.stringify(owners),
  );
  check("  └ 다른 계정의 기록은 그대로다", owners["http://dave/v1"] === "dave", JSON.stringify(owners));
}

await fs.rm(root, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
