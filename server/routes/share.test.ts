// 대화 공유 링크 검사. `npm test` 로 돈다.
//
// 확인하려는 것:
//   1. 공유 경로만 로그인 없이 열린다(그 밖의 /api 는 그대로 막힌다).
//   2. 링크가 보여 주는 것은 공유한 순간의 사본이다 — 이어 간 대화는 보이지 않고,
//      다시 공유하면 같은 링크가 지금 모습으로 바뀐다.
//   3. 받는 쪽에는 읽기만 있다. 사본에 이어 쓸 경로가 없다.
//   4. 남의 공유 토큰을 골라 그 사본을 덮어쓸 수 없고, 짧은(추측 가능한) 토큰은 받지 않는다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "share-test-"));
process.env.DATA_DIR = dataDir;

const { shareRouter } = await import("./share.js");
const { isPublicApiPath } = await import("../middleware/auth.js");
const { createConversation, getConversation } = await import("../storage/conversationStore.js");
const { saveAttachment } = await import("../storage/attachmentStore.js");
const { writeJsonFileAtomic } = await import("../storage/atomic.js");
const { conversationFile } = await import("../storage/paths.js");

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

console.log("server/routes/share.ts + storage/shareStore.ts");

/* ------------------------------------------------------------- 공개 경로 */

{
  const token = "a".repeat(22);
  check("공유 사본은 로그인 없이", isPublicApiPath(`/shared/${token}`));
  check("사본의 첨부도", isPublicApiPath(`/shared/${token}/attachments/abc-1`));
  check("공유하기(토큰 만들기)는 로그인 필요", !isPublicApiPath("/conversations/c1/share"));
  check("다른 경로는 그대로 막힌다", !isPublicApiPath("/conversations") && !isPublicApiPath(`/shared/${token}/x`));
  check("../ 로 빠져나갈 수 없다", !isPublicApiPath(`/shared/../conversations`));
}

/* ---------------------------------------------------------------- 라우터 */

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = req.headers["x-as"];
  if (typeof who === "string") req.ownerId = who;
  next();
});
app.use("/api", shareRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

async function call(as: string | null, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { ...(as ? { "x-as": as } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown>, headers: res.headers };
}

const now = new Date().toISOString();
const conversation = await createConversation("alice", { title: "공유 시험" });
const attachment = { id: "att-1", name: "그림.png", mime: "image/png", kind: "image", bytes: 4, createdAt: now } as never;
await saveAttachment("alice", conversation.id, attachment, Buffer.from([1, 2, 3, 4]));
conversation.messages = [
  { id: "u1", role: "user", content: "첫 질문", attachments: [attachment], createdAt: now },
  { id: "a1", role: "assistant", content: "첫 답", createdAt: now },
] as never;
await writeJsonFileAtomic(conversationFile("alice", conversation.id), conversation);

const token = "T".repeat(11) + "x".repeat(11);

{
  const before = await call("alice", "GET", `/conversations/${conversation.id}/share`);
  check("공유 전에는 토큰이 없다", before.status === 200 && before.json.token === null, JSON.stringify(before.json));

  const short = await call("alice", "PUT", `/conversations/${conversation.id}/share`, { token: "short" });
  check("짧은 토큰은 400", short.status === 400);

  const saved = await call("alice", "PUT", `/conversations/${conversation.id}/share`, { token });
  check("처음 공유는 보낸 토큰을 쓴다", saved.status === 200 && saved.json.token === token, JSON.stringify(saved.json));

  const shared = await call(null, "GET", `/shared/${token}`);
  const messages = shared.json.messages as Array<{ content: string }>;
  check("받는 쪽이 대화를 본다", shared.status === 200 && shared.json.title === "공유 시험" && messages.length === 2);
  check("공용 캐시에 남지 않는다", shared.headers.get("cache-control")?.includes("no-store"));
  check("시스템 프롬프트·설정은 내주지 않는다", !("systemPrompt" in shared.json) && !("settings" in shared.json));

  const file = await call(null, "GET", `/shared/${token}/attachments/att-1`);
  check("첨부 사본을 받는다", file.status === 200 && file.headers.get("content-type") === "image/png");

  // 공유 뒤에 대화가 이어진다 — 링크에는 보이지 않아야 한다.
  const later = (await getConversation("alice", conversation.id))!;
  later.messages.push({ id: "u2", role: "user", content: "나중 질문", createdAt: now } as never);
  await writeJsonFileAtomic(conversationFile("alice", conversation.id), later);
  const still = await call(null, "GET", `/shared/${token}`);
  check("공유 뒤의 대화는 보이지 않는다", (still.json.messages as unknown[]).length === 2);

  const again = await call("alice", "PUT", `/conversations/${conversation.id}/share`, { token: "Z".repeat(22) });
  check("다시 공유하면 원래 토큰을 돌려준다", again.json.token === token, JSON.stringify(again.json));
  const updated = await call(null, "GET", `/shared/${token}`);
  check("…그리고 사본이 지금 모습이 된다", (updated.json.messages as unknown[]).length === 3);

  const known = await call("alice", "GET", `/conversations/${conversation.id}/share`);
  check("공유한 토큰을 알려 준다", known.json.token === token);
}

{
  // 남의 토큰을 골라 그 사본을 덮어쓰려는 시도.
  const mine = await createConversation("bob", { title: "밥의 대화" });
  mine.messages = [{ id: "b1", role: "user", content: "밥", createdAt: now }] as never;
  await writeJsonFileAtomic(conversationFile("bob", mine.id), mine);
  const steal = await call("bob", "PUT", `/conversations/${mine.id}/share`, { token });
  check("이미 쓰인 토큰은 409", steal.status === 409, JSON.stringify(steal.json));
  const intact = await call(null, "GET", `/shared/${token}`);
  check("…원래 사본은 그대로다", intact.json.title === "공유 시험");

  const others = await call("bob", "PUT", `/conversations/${conversation.id}/share`, { token: "B".repeat(22) });
  check("남의 대화는 공유할 수 없다(404)", others.status === 404);

  const empty = await createConversation("bob", { title: "빈 대화" });
  const none = await call("bob", "PUT", `/conversations/${empty.id}/share`, { token: "C".repeat(22) });
  check("빈 대화는 공유하지 않는다(400)", none.status === 400);
}

{
  // 받는 쪽에는 읽기만 있다.
  const post = await call(null, "POST", `/shared/${token}`, { content: "이어서" });
  const put = await call(null, "PUT", `/shared/${token}`, { content: "이어서" });
  const del = await call(null, "DELETE", `/shared/${token}`);
  check("사본에 쓰는 경로가 없다", [post, put, del].every((r) => r.status === 404), [post, put, del].map((r) => r.status).join(","));
  const missing = await call(null, "GET", `/shared/${"q".repeat(22)}`);
  check("없는 토큰은 404", missing.status === 404);
}

server.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
