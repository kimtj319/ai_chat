// 답변 👍/👎(PUT /api/conversations/:id/messages/:messageId/feedback) 계약 검사.
// `npx tsx server/routes/feedback.test.ts` 로 돈다.
//
// 확인하려는 것.
//   1. 답에 👍·👎 를 남기면 그 메시지에 저장되어 다시 열어도 보인다.
//   2. 같은 답에 다시 누르면 바뀌고, null 이면 지워진다(토글).
//   3. 바뀔 때마다 소유자 폴더의 feedback.jsonl 에 한 줄씩 쌓인다(대화·메시지·모델·평가·이유·시각).
//   4. 평가는 대화의 updatedAt 을 바꾸지 않는다(목록 맨 위로 올라오지 않는다).
//   5. 사용자 메시지·없는 메시지·남의 대화·잘못된 값은 거절하고 아무것도 쓰지 않는다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

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

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-route-test-"));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";

const { conversationsRouter } = await import("./conversations.js");
const { createConversation, getConversation, mutateConversation } = await import("../storage/conversationStore.js");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.ownerId = String(req.headers["x-as"] ?? "alice");
  next();
});
app.use("/api", conversationsRouter);

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

async function rate(id: string, messageId: string, body: unknown, as = "alice"): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/conversations/${id}/messages/${messageId}/feedback`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-as": as },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function logLines(owner: string): Promise<any[]> {
  try {
    const text = await fs.readFile(path.join(dataDir, "owners", owner, "feedback.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

console.log("server/routes/conversations.ts — PUT /conversations/:id/messages/:messageId/feedback");

const conv = await createConversation("alice", { model: "model-x" });
await mutateConversation("alice", conv.id, (c) => {
  c.messages.push(
    { id: "u1", role: "user", content: "질문", createdAt: "2026-10-18T00:00:00.000Z" },
    { id: "a1", role: "assistant", content: "답", createdAt: "2026-10-18T00:00:01.000Z" },
  );
  return c;
});
const stored = async () => (await getConversation("alice", conv.id))?.messages.find((m) => m.id === "a1");

/* ------------------------------------------------------------------ 1) 👍 */
{
  const updatedBefore = (await getConversation("alice", conv.id))?.updatedAt;
  const r = await rate(conv.id, "a1", { rating: "up" });
  check("  └ 대화의 updatedAt 은 그대로다(목록 순서가 바뀌지 않는다)", (await getConversation("alice", conv.id))?.updatedAt === updatedBefore);
  check("👍 는 200", r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  check("  └ 응답이 저장된 평가를 돌려준다", r.json?.feedback?.rating === "up", JSON.stringify(r.json));
  check("  └ 메시지에 저장된다", (await stored())?.feedback?.rating === "up", JSON.stringify(await stored()));
}

/* -------------------------------------------------------- 2) 👎 + 이유, 토글 */
{
  const r = await rate(conv.id, "a1", { rating: "down", reason: "  표가 틀렸어요  " });
  check("👎 로 바꿀 수 있다", r.status === 200 && (await stored())?.feedback?.rating === "down", JSON.stringify(await stored()));
  check("  └ 이유는 다듬어 저장된다", (await stored())?.feedback?.reason === "표가 틀렸어요", JSON.stringify(await stored()));
  const cleared = await rate(conv.id, "a1", { rating: null });
  check("null 이면 지운다", cleared.status === 200 && cleared.json?.feedback === null, JSON.stringify(cleared.json));
  check("  └ 메시지에서도 사라진다", (await stored())?.feedback === undefined, JSON.stringify(await stored()));
}

/* ------------------------------------------------------------- 3) 기록 한 줄씩 */
{
  const lines = await logLines("alice");
  check("바뀔 때마다 한 줄(3줄)", lines.length === 3, JSON.stringify(lines));
  const [first, second, third] = lines;
  check(
    "  └ 대화·메시지·모델·평가가 담긴다",
    first?.conversationId === conv.id && first?.messageId === "a1" && first?.model === "model-x" && first?.rating === "up",
    JSON.stringify(first),
  );
  check("  └ 이유도 담긴다", second?.rating === "down" && second?.reason === "표가 틀렸어요", JSON.stringify(second));
  check("  └ 지운 것도 null 로 남는다", third?.rating === null, JSON.stringify(third));
  check("  └ 시각이 있다", typeof first?.at === "string" && !Number.isNaN(Date.parse(first.at)), JSON.stringify(first));
}

/* ------------------------------------------------------------------ 4) 거절 */
{
  const before = (await logLines("alice")).length;
  const user = await rate(conv.id, "u1", { rating: "up" });
  check("사용자 메시지에는 400", user.status === 400, String(user.status));
  const missing = await rate(conv.id, "nope", { rating: "up" });
  check("없는 메시지는 404", missing.status === 404, String(missing.status));
  const stranger = await rate(conv.id, "a1", { rating: "up" }, "bob");
  check("남의 대화는 404", stranger.status === 404, String(stranger.status));
  const bad = await rate(conv.id, "a1", { rating: "great" });
  check("모르는 평가는 400", bad.status === 400, String(bad.status));
  const long = await rate(conv.id, "a1", { rating: "down", reason: "가".repeat(501) });
  check("너무 긴 이유는 400", long.status === 400, String(long.status));
  check("거절된 요청은 기록에 남지 않는다", (await logLines("alice")).length === before, String((await logLines("alice")).length));
  check("  └ 메시지도 그대로다", (await stored())?.feedback === undefined, JSON.stringify(await stored()));
}

server.close();

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
