// GET /api/conversations/:id/context — 입력창의 컨텍스트 사용률. `npx tsx server/routes/conversations.context.test.ts`
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "context-route-test-"));
process.env.VLLM_ENDPOINTS = "big|http://mock-big/v1,gw|http://mock-gw/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
delete process.env.MODEL_CONTEXT_LENGTHS;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const tokenized: string[] = [];
const tokenizedTools: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("http://mock-")) return realFetch(input as never, init);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === "http://mock-big/v1/models") return json({ data: [{ id: "big-model", max_model_len: 100_000 }] });
  // 게이트웨이(LiteLLM)처럼 길이를 알려 주지 않는다.
  if (url === "http://mock-gw/v1/models") return json({ data: [{ id: "wisenut/wise-lloa-max-v1.2.1" }] });
  if (url === "http://mock-big/tokenize") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    tokenized.push(JSON.stringify(body.messages ?? []));
    tokenizedTools.push(Array.isArray(body.tools) ? body.tools.length : 0);
    // 메시지가 많은 대화는 창의 60% 를, 아주 많은 대화는 85% 를 쓴 것으로 답한다.
    const n = (body.messages ?? []).length;
    return json({ count: n > 12 ? 85_000 : n > 6 ? 60_000 : 1234, max_model_len: 100_000 });
  }
  if (url === "http://mock-gw/tokenize") return new Response("not found", { status: 404 });
  throw new Error(`예상하지 못한 요청: ${url}`);
}) as typeof fetch;

const { conversationsRouter } = await import("./conversations.js");
const { createConversation, mutateConversation } = await import("../storage/conversationStore.js");
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.ownerId = "alice";
  next();
});
app.use("/api", conversationsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

console.log("server/routes/conversations.ts — GET /conversations/:id/context");

const conv = await createConversation("alice", { model: "big-model" });
await mutateConversation("alice", conv.id, (c) => {
  c.messages.push({ id: "u1", role: "user", content: "질문입니다", createdAt: new Date().toISOString() });
  c.messages.push({ id: "a1", role: "assistant", content: "답변입니다 ".repeat(200), createdAt: new Date().toISOString() });
  return c;
});

{
  const res = await fetch(`${base}/conversations/${conv.id}/context`);
  const body = await res.json();
  check("대화의 모델로 잰다(토큰 계산기 값·길이)", res.status === 200 && body.model === "big-model" && body.tokens === 1234 && body.exact === true && body.contextWindow === 100_000, JSON.stringify(body));
  check("요약·도구 중단 기준선을 함께 준다", body.summaryRatio === 0.8 && body.toolStopRatio === 0.8, JSON.stringify(body));
  check("짧은 대화는 다음 질문에서 요약하지 않는다", body.willSummarize === false, JSON.stringify(body));
  check("다음 턴이 보낼 기록(답변 포함)을 잰다", tokenized.some((m) => m.includes("답변입니다")), tokenized[0]?.slice(0, 120));
  check("켠 도구의 정의도 함께 잰다", (tokenizedTools[0] ?? 0) > 0, JSON.stringify(tokenizedTools));
}

{
  const res = await fetch(`${base}/conversations/${conv.id}/context?model=${encodeURIComponent("wisenut/wise-lloa-max-v1.2.1")}`);
  const body = await res.json();
  check("다른 모델을 고르면 그 모델 기준으로 다시 잰다", body.model === "wisenut/wise-lloa-max-v1.2.1", JSON.stringify(body));
  check("길이를 안 알려 주는 wise-lloa-max 는 설정값 131072", body.contextWindow === 131_072, JSON.stringify(body));
  check("토큰 계산기가 없으면 추정값으로 표시", body.exact === false && body.tokens > 0, JSON.stringify(body));
}

{
  const long = await createConversation("alice", { model: "big-model" });
  await mutateConversation("alice", long.id, (c) => {
    for (let i = 0; i < 4; i++) {
      c.messages.push({ id: `lu${i}`, role: "user", content: `질문 ${i}`, createdAt: new Date().toISOString() });
      c.messages.push({ id: `la${i}`, role: "assistant", content: `답변 ${i}`, createdAt: new Date().toISOString() });
    }
    return c;
  });
  const body = await (await fetch(`${base}/conversations/${long.id}/context`)).json();
  check("60% 로는 아직 요약하지 않는다(기준 80%)", body.willSummarize === false && body.tokens === 60_000, JSON.stringify(body));
  await mutateConversation("alice", long.id, (c) => {
    for (let i = 4; i < 8; i++) {
      c.messages.push({ id: `lu${i}`, role: "user", content: `질문 ${i}`, createdAt: new Date().toISOString() });
      c.messages.push({ id: `la${i}`, role: "assistant", content: `답변 ${i}`, createdAt: new Date().toISOString() });
    }
    return c;
  });
  const fuller = await (await fetch(`${base}/conversations/${long.id}/context`)).json();
  check("80% 를 넘으면 다음 질문에서 요약한다고 알린다", fuller.willSummarize === true && fuller.tokens === 85_000, JSON.stringify(fuller));
}

{
  const res = await fetch(`${base}/conversations/00000000-0000-4000-8000-000000000000/context`);
  check("없는(남의) 대화는 404", res.status === 404, String(res.status));
}

server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
