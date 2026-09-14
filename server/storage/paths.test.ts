// 저장 경로 검사. `npm test` 로 돈다.
//
// 여기서 지키는 것은 하나다: **id 로 만든 경로는 DATA_DIR 밖으로 나가지
// 못한다.** 이게 깨지면 한 계정이 남의 대화를 읽거나, 서버의 아무 파일이나
// 덮어쓸 수 있다 — 그리고 화면에는 아무 오류도 나지 않는다.
//
// 이 파일의 함수들은 스스로 검증하지 않는다. `path.join` 만 한다. 안전한
// 이유는 **부르는 쪽이 isValidId 로 먼저 거르기 때문**이고(라우트와 저장소
// 양쪽에서), 그 약속이 이 검사가 지키려는 것이다. 그래서 두 방향을 다 본다.
//
//   1. isValidId 가 통과시킨 id 로는 어떤 함수도 밖으로 나가지 못한다
//   2. isValidId 가 막는 id 는 실제로 밖으로 나간다 — 왜 걸러야 하는지의 증거
import path from "node:path";
import { config } from "../config.js";
import * as P from "./paths.js";

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

const ROOT = path.resolve(config.dataDir);

/** 이 경로가 DATA_DIR 안에 있는가. 경계 문자까지 붙여 "dataX" 가 "data" 안으로 세지 않게 한다. */
function inside(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === ROOT || resolved.startsWith(ROOT + path.sep);
}

/** id 를 받는 함수들. 인자 수만큼 같은 id 를 넣어 본다. */
const BUILDERS: Array<[string, (...ids: string[]) => string, number]> = [
  ["sessionDir", P.sessionDir, 1],
  ["sessionFile", P.sessionFile, 1],
  ["userFile", P.userFile, 1],
  ["groupFile", P.groupFile, 1],
  ["ownerDir", P.ownerDir, 1],
  ["conversationsDir", P.conversationsDir, 1],
  ["ownerAttachmentsDir", P.ownerAttachmentsDir, 1],
  ["documentsDir", P.documentsDir, 1],
  ["mcpServerFile", P.mcpServerFile, 1],
  ["ownerMcpFile", P.ownerMcpFile, 1],
  ["conversationFile", P.conversationFile, 2],
  ["attachmentsDir", P.attachmentsDir, 2],
  ["documentTextFile", P.documentTextFile, 2],
  ["documentMetaFile", P.documentMetaFile, 2],
  ["documentChunksFile", P.documentChunksFile, 2],
  ["attachmentBinFile", P.attachmentBinFile, 3],
  ["attachmentMetaFile", P.attachmentMetaFile, 3],
];

/** 인자를 받지 않는 것들. 늘 안에 있어야 한다. */
const ROOTS: Array<[string, () => string]> = [
  ["sessionsDir", P.sessionsDir],
  ["usersDir", P.usersDir],
  ["groupsDir", P.groupsDir],
  ["ownersRoot", P.ownersRoot],
  ["ownersDir", P.ownersDir],
  ["mcpDir", P.mcpDir],
  ["mcpServersDir", P.mcpServersDir],
  ["mcpSeedMarkerFile", P.mcpSeedMarkerFile],
];

console.log("server/storage/paths.ts");

/* ------------------------------------------------------------ isValidId */

{
  const good = ["a", "A1", "user-1", "user_1", "doc_022e85c549dd", "0", "x".repeat(64)];
  for (const id of good) check(`받아들인다: ${id.length > 20 ? id.slice(0, 17) + "…" : id}`, P.isValidId(id));
}
{
  // 경로를 벗어나게 하거나, 파일 이름을 비트는 값들.
  const bad: Array<[string, unknown]> = [
    ["상위로 올라가기", ".."],
    ["상위로 두 번", "../.."],
    ["섞인 상위", "a/../../b"],
    ["슬래시", "a/b"],
    ["역슬래시", "a\\b"],
    ["절대 경로", "/etc/passwd"],
    ["점 하나", "."],
    ["빈 문자열", ""],
    ["공백", " "],
    ["공백 포함", "a b"],
    ["널 바이트", "a\u0000b"],
    ["줄바꿈", "a\nb"],
    ["65자", "x".repeat(65)],
    ["한글", "사용자1"],
    ["전각 슬래시", "a／b"],
    ["퍼센트 인코딩", "%2e%2e"],
    ["틸드", "~"],
    ["콜론", "C:"],
    ["문자열이 아님", 123],
    ["null", null],
    ["undefined", undefined],
    ["객체", { toString: () => "ok" }],
  ];
  for (const [label, id] of bad) check(`막는다: ${label}`, !P.isValidId(id));
}

/* ------------------------------- 1. 통과한 id 로는 밖으로 나가지 못한다 */

{
  const accepted = ["a", "user-1", "user_1", "0", "x".repeat(64), "doc_022e85c549dd", "ABC123"];
  let escapes = 0;
  for (const [name, fn, arity] of BUILDERS) {
    for (const id of accepted) {
      const p = fn(...Array.from({ length: arity }, () => id));
      if (!inside(p)) {
        escapes++;
        console.log(`     ${name}("${id}") → ${p}`);
      }
    }
  }
  check(`통과한 id 로는 ${BUILDERS.length}개 함수 모두 DATA_DIR 안에 머문다`, escapes === 0, `${escapes}건 벗어남`);
}
{
  let outside = 0;
  for (const [name, fn] of ROOTS) {
    if (!inside(fn())) {
      outside++;
      console.log(`     ${name}() → ${fn()}`);
    }
  }
  check("인자 없는 경로들도 전부 안에 있다", outside === 0, `${outside}건`);
}
{
  // 서로 다른 소유자의 경로가 섞이지 않아야 한다.
  const a = P.conversationFile("alice", "c1");
  const b = P.conversationFile("bob", "c1");
  check("소유자가 다르면 경로가 다르다", a !== b, `${a} / ${b}`);
  check("소유자 경로는 서로를 품지 않는다", !a.startsWith(path.dirname(b)) && !b.startsWith(path.dirname(a)));
  check("소유자 id 가 경로에 그대로 들어간다", a.includes(`${path.sep}alice${path.sep}`), a);
}

/* -------------------- 2. 막힌 id 는 실제로 위험하다 (걸러야 하는 이유) */

{
  // 이 검사는 "검증을 빼먹으면 어떻게 되는가" 를 기록으로 남긴다. 통과하는
  // 것이 목적이 아니라, 검증이 장식이 아니라는 증거가 목적이다.
  const traversal = "../../../../etc";
  check("isValidId 는 이 값을 막는다", !P.isValidId(traversal));
  check(
    "막지 않았다면 DATA_DIR 밖으로 나갔을 것이다",
    !inside(P.ownerDir(traversal)),
    P.ownerDir(traversal),
  );
  check(
    "두 번째 인자로도 마찬가지다",
    !inside(P.conversationFile("alice", traversal)),
    P.conversationFile("alice", traversal),
  );
  // 절대 경로는 밖으로 **나가지 않는다** — path.join 이 선행 슬래시를 구분자로
  // 흡수하기 때문이다. 그래도 막아야 하는 이유는 다르다: 뜻하지 않은 하위
  // 디렉터리가 생기고, 파일 이름이 계정 id 가 아니게 된다.
  const abs = P.userFile("/etc/passwd");
  check("절대 경로는 밖으로 나가지는 않는다", inside(abs), abs);
  check("대신 엉뚱한 곳에 자리를 잡는다", abs.includes(`${path.sep}etc${path.sep}`), abs);
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
