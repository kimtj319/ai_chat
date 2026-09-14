// 문서 저장소 검사. `npm test` 로 돈다.
//
// 이 검사가 지키는 것은 하나다: **비공개 문서는 공개 목록에 나오지 않는다.**
//
// listSharedDocuments 는 이 저장소에서 유일하게 **남의 디렉터리를 읽는** 함수다.
// 여기서 scope 를 한 번 잘못 보면 남의 비공개 문서 제목이 모두의 화면에 뜬다 —
// 그리고 아무 오류도 나지 않아서, 누군가 알아채기 전까지는 그대로다.
//
// config 는 불러들일 때 DATA_DIR 을 읽으므로 import 보다 먼저 세운다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "docstore-test-"));
process.env.DATA_DIR = root;

const { findSharedDocument, listDocuments, listSharedDocuments, saveDocumentMeta } = await import("./documentStore.js");
type RagDocument = Parameters<typeof saveDocumentMeta>[1];

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

let clock = 0;
const doc = (id: string, scope: "private" | "shared"): RagDocument => {
  clock += 1000;
  return {
    id,
    name: `${id}.md`,
    mime: "text/markdown",
    bytes: 10,
    chars: 10,
    chunks: 1,
    chunkedBy: "rule",
    scope,
    status: "ready",
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
  } as RagDocument;
};

console.log("server/storage/documentStore.ts");

/* --------------------------------------------------------------- 자료 만들기 */

await saveDocumentMeta("alice", doc("a_priv", "private"));
await saveDocumentMeta("alice", doc("a_open", "shared"));
await saveDocumentMeta("bob", doc("b_priv", "private"));
await saveDocumentMeta("bob", doc("b_open", "shared"));
await saveDocumentMeta("carol", doc("c_priv", "private"));

/* ------------------------------------- 공개 목록에는 공개만 들어간다 */

{
  const shared = await listSharedDocuments();
  const ids = shared.map((d) => d.id).sort();
  check("공개한 것만 모인다", ids.join(",") === "a_open,b_open", ids.join(","));
  check("소유자를 가로질러 모은다", new Set(shared.map((d) => d.ownerId)).size === 2, JSON.stringify(shared.map((d) => d.ownerId)));
  check("어느 것이 누구 것인지 맞다",
    shared.find((d) => d.id === "a_open")?.ownerId === "alice" && shared.find((d) => d.id === "b_open")?.ownerId === "bob");

  // 이 두 줄이 이 파일의 존재 이유다.
  check("비공개는 한 건도 섞이지 않는다", shared.every((d) => d.scope === "shared"), JSON.stringify(shared.map((d) => d.scope)));
  for (const secret of ["a_priv", "b_priv", "c_priv"]) {
    check(`비공개가 새지 않는다: ${secret}`, !ids.includes(secret));
  }
  check("공개한 것이 없는 계정은 아예 안 나온다", !shared.some((d) => d.ownerId === "carol"));
}
{
  const shared = await listSharedDocuments();
  const times = shared.map((d) => d.createdAt);
  check("새것이 먼저 온다", [...times].sort().reverse().join() === times.join(), times.join(" / "));
}

/* ----------------------------------------- 내 목록은 내 것 전부 (공개 여부 무관) */

{
  const mine = (await listDocuments("alice")).map((d) => d.id).sort();
  check("내 목록에는 내 비공개도 들어간다", mine.join(",") === "a_open,a_priv", mine.join(","));
  const others = (await listDocuments("bob")).map((d) => d.id).sort();
  check("남의 목록에 내 것이 섞이지 않는다", others.join(",") === "b_open,b_priv", others.join(","));
  check("문서가 없는 계정은 빈 목록", (await listDocuments("없는사람")).length === 0);
}

/* ----------------------------------------------- id 하나로 공개 문서 찾기 */

{
  const found = await findSharedDocument("b_open");
  check("공개 문서를 id 로 찾는다", found?.ownerId === "bob", JSON.stringify(found));
  check("비공개는 찾히지 않는다", (await findSharedDocument("a_priv")) === null);
  check("없는 id 는 null", (await findSharedDocument("없는문서")) === null);
  // 경로를 벗어나려는 값은 여기서도 막힌다.
  check("이상한 id 는 null", (await findSharedDocument("../../etc")) === null);
}

/* ------------------------------------------------- 디렉터리가 이상할 때 */

{
  // 우리가 만들지 않은 이름의 디렉터리는 계정이 아니다.
  await fs.mkdir(path.join(root, "owners", ".숨김"), { recursive: true });
  await fs.mkdir(path.join(root, "owners", "이상한 이름"), { recursive: true });
  const shared = await listSharedDocuments();
  check("계정 id 모양이 아닌 디렉터리는 건너뛴다", shared.length === 2, String(shared.length));
}

await fs.rm(root, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
