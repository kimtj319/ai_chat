// 대화 고정(PATCH /api/conversations/:id {"pinned": …}) 검사. `npm test` 로 돈다.
//
// 확인하려는 것.
//   1. 고정은 서버에 남는다 — 목록 요약에 pinned 가 실려 다른 기기·새로고침에서도 위에 있다.
//   2. 고정·해제는 대화를 "바꾼" 것이 아니다. updatedAt 이 그대로라 날짜 묶음과 순서가
//      흔들리지 않는다(이름 바꾸기와 다르다).
//   3. 참/거짓이 아닌 값은 400 이고, 아무것도 바꾸지 않는다.
//   4. 남의 대화는 고정할 수 없다(404).
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pin-route-test-"));
process.env.DATA_DIR = dataDir;

const { conversationsRouter } = await import("./conversations.js");
const store = await import("../storage/conversationStore.js");

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

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = req.headers["x-as"];
  req.ownerId = typeof who === "string" ? who : "alice";
  next();
});
app.use("/api", conversationsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

async function patch(id: string, body: unknown, as = "alice"): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-as": as },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function list(as = "alice"): Promise<any[]> {
  const res = await fetch(`${base}/conversations`, { headers: { "x-as": as } });
  return (await res.json()) as any[];
}

console.log("server/routes/conversations.ts (pinned)");

const say = (conv: any) => {
  conv.messages.push({ id: crypto.randomUUID(), role: "user", content: "안녕", createdAt: new Date().toISOString() });
};
const older = await store.createConversation("alice", { title: "오래된 대화" });
await store.mutateConversation("alice", older.id, say);
await new Promise((r) => setTimeout(r, 5));
const newer = await store.createConversation("alice", { title: "새 대화 하나" });
await store.mutateConversation("alice", newer.id, say);

const before = await list();
check("처음에는 아무것도 고정되어 있지 않다", before.every((c) => !c.pinned), JSON.stringify(before));
const olderUpdatedAt = before.find((c) => c.id === older.id)?.updatedAt;

{
  const res = await patch(older.id, { pinned: true });
  check("고정은 200", res.status === 200, String(res.status));
  check("응답에 pinned: true", res.body?.pinned === true, JSON.stringify(res.body?.pinned));
  const after = await list();
  const row = after.find((c) => c.id === older.id);
  check("목록 요약에 pinned 가 실린다", row?.pinned === true, JSON.stringify(row));
  check("고정해도 updatedAt 은 그대로", row?.updatedAt === olderUpdatedAt, `${olderUpdatedAt} → ${row?.updatedAt}`);
  check("고정해도 서버 순서(최근 것부터)는 그대로", after.map((c) => c.id).join() === `${newer.id},${older.id}`);
  const stored = await store.getConversation("alice", older.id);
  check("파일에 남는다", stored?.pinned === true, JSON.stringify(stored?.pinned));
}

{
  const res = await patch(older.id, { pinned: false });
  check("해제도 200", res.status === 200, String(res.status));
  const row = (await list()).find((c) => c.id === older.id);
  check("해제하면 목록에서 고정이 빠진다", !row?.pinned, JSON.stringify(row));
  check("해제해도 updatedAt 은 그대로", row?.updatedAt === olderUpdatedAt, `${olderUpdatedAt} → ${row?.updatedAt}`);
}

{
  const res = await patch(older.id, { pinned: "yes" });
  check("참/거짓이 아니면 400", res.status === 400, String(res.status));
  check("  어느 칸인지 말한다", res.body?.field === "pinned", JSON.stringify(res.body));
  const row = (await list()).find((c) => c.id === older.id);
  check("  그리고 아무것도 바꾸지 않는다", !row?.pinned);
}

{
  const res = await patch(older.id, { pinned: true, title: "고정하며 이름도" });
  check("다른 칸과 함께 보내면 둘 다 반영", res.status === 200 && res.body?.pinned === true && res.body?.title === "고정하며 이름도");
}

{
  const res = await patch(newer.id, { pinned: true }, "mallory");
  check("남의 대화는 404", res.status === 404, String(res.status));
  check("  주인의 목록은 그대로", !(await list()).find((c) => c.id === newer.id)?.pinned);
}

server.close();
await fs.rm(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
