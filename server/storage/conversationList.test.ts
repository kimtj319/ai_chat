// 대화 목록 요약 캐시 검사 — 캐시가 바뀐 대화를 놓치지 않는가. `npm test` 로 돈다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-list-"));
process.env.DATA_DIR = dataDir;
const store = await import("./conversationStore.js");

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
const say = (text: string) => (conv: any) => {
  conv.messages.push({ id: crypto.randomUUID(), role: "user", content: text, createdAt: new Date().toISOString() });
  conv.updatedAt = new Date().toISOString();
  return conv;
};

console.log("server/storage/conversationStore.ts (listConversations cache)");
const a = await store.createConversation("alice", { title: "첫 대화" });
const b = await store.createConversation("alice", { title: "둘째" });
check("메시지 없는 대화는 목록에 없다", (await store.listConversations("alice")).length === 0);
await store.mutateConversation("alice", a.id, say("안녕"));
let list = await store.listConversations("alice");
check("첫 메시지가 생기면 목록에 나온다", list.length === 1 && list[0]!.id === a.id && list[0]!.messageCount === 1, JSON.stringify(list));
await store.mutateConversation("alice", a.id, (conv: any) => ({ ...conv, title: "이름 바꿈" }));
list = await store.listConversations("alice");
check("제목을 바꾸면 바로 반영(캐시가 낡지 않는다)", list[0]!.title === "이름 바꿈", list[0]!.title);
await store.mutateConversation("alice", a.id, say("두 번째"));
list = await store.listConversations("alice");
check("메시지 수도 갱신", list[0]!.messageCount === 2, String(list[0]!.messageCount));
// updatedAt 은 밀리초 단위라 같은 순간의 두 쓰기는 순서가 갈리지 않는다.
await new Promise((r) => setTimeout(r, 5));
await store.mutateConversation("alice", b.id, say("b 시작"));
list = await store.listConversations("alice");
check("새로 바뀐 대화가 위로", list.map((c) => c.id).join() === `${b.id},${a.id}`, list.map((c) => c.title).join());
list[0]!.title = "호출자가 고친 값";
check("돌려준 요약을 고쳐도 캐시는 그대로", (await store.listConversations("alice"))[0]!.title === "둘째");
await store.deleteConversation("alice", a.id);
list = await store.listConversations("alice");
check("지운 대화는 빠진다", list.length === 1 && list[0]!.id === b.id);
check("다른 사람의 목록과 섞이지 않는다", (await store.listConversations("bob")).length === 0);

await fs.rm(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
