// 공지사항 검사. `npm test` 로 돈다.
//
// 보려는 것은 셋이다: 관리자가 아니면 쓰거나 지우지 못한다, 새 공지가 "안 본 것" 으로
// 세어진다, 한 번 보면(seen) 그 계정에서만 0 이 된다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "notices-test-"));
process.env.DATA_DIR = dataDir;

const { noticesRouter } = await import("./notices.js");

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

// 인증 흉내: X-As 헤더가 곧 계정이고 "admin" 이면 관리자다(board.test.ts 와 같은 방식).
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "alice");
  req.ownerId = who;
  req.user = { id: who, role: who === "admin" ? "admin" : "user" } as never;
  next();
});
app.use("/api", noticesRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

async function call(as: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { "x-as": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

console.log("server/routes/notices.ts + storage/noticeStore.ts");

try {
  const empty = await call("alice", "GET", "/notices");
  check("처음엔 공지가 없고 안 본 것도 0", empty.status === 200 && empty.json.notices.length === 0 && empty.json.unread === 0, JSON.stringify(empty.json));

  const denied = await call("alice", "POST", "/admin/notices", { title: "몰래 공지" });
  check("관리자가 아니면 쓰지 못한다", denied.status === 403, String(denied.status));

  const blank = await call("admin", "POST", "/admin/notices", { title: "   ", body: "본문" });
  check("제목이 비면 400", blank.status === 400, String(blank.status));

  const first = await call("admin", "POST", "/admin/notices", { title: "점검 안내", body: "오늘 18시에 재시작합니다." });
  check("관리자는 쓴다", first.status === 201 && first.json.notice.title === "점검 안내", JSON.stringify(first.json));
  const id = first.json.notice.id as string;

  const aliceSees = await call("alice", "GET", "/notices");
  check("새 공지는 안 본 것으로 센다", aliceSees.json.unread === 1 && aliceSees.json.notices[0].id === id, JSON.stringify(aliceSees.json));

  const seen = await call("alice", "POST", "/notices/seen");
  check("본 뒤에는 0", seen.status === 200 && seen.json.unread === 0);
  const aliceAfter = await call("alice", "GET", "/notices");
  check("다시 읽어도 0 — 서버에 남는다", aliceAfter.json.unread === 0, JSON.stringify(aliceAfter.json));
  const bob = await call("bob", "GET", "/notices");
  check("다른 계정에는 여전히 새것", bob.json.unread === 1, JSON.stringify(bob.json));

  await new Promise((r) => setTimeout(r, 5));
  await call("admin", "POST", "/admin/notices", { title: "두 번째 공지" });
  const aliceNew = await call("alice", "GET", "/notices");
  check("본 뒤에 올라온 공지만 새것", aliceNew.json.unread === 1 && aliceNew.json.notices[0].title === "두 번째 공지", JSON.stringify(aliceNew.json));

  const editDenied = await call("alice", "PATCH", `/admin/notices/${id}`, { title: "바꿈" });
  check("관리자가 아니면 고치지 못한다", editDenied.status === 403);
  const edited = await call("admin", "PATCH", `/admin/notices/${id}`, { title: "점검 안내(변경)" });
  check("관리자는 고친다", edited.status === 200 && edited.json.notice.title === "점검 안내(변경)");
  const afterEdit = await call("alice", "GET", "/notices");
  check("고쳐도 순서와 '새것' 판단은 처음 올린 때를 따른다", afterEdit.json.notices[1].id === id && afterEdit.json.unread === 1, JSON.stringify(afterEdit.json));

  const delDenied = await call("alice", "DELETE", `/admin/notices/${id}`);
  check("관리자가 아니면 지우지 못한다", delDenied.status === 403);
  const del = await call("admin", "DELETE", `/admin/notices/${id}`);
  check("관리자는 지운다", del.status === 204);
  const gone = await call("admin", "DELETE", `/admin/notices/${id}`);
  check("없는 공지를 지우면 404", gone.status === 404);
  const bad = await call("admin", "DELETE", "/admin/notices/..%2Fusers");
  check("이상한 id 는 파일 경로가 되지 않는다", bad.status === 404, String(bad.status));
} finally {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
