// 다시 생성·편집 후 재전송(POST /api/conversations/:id/messages {"regenerate": true}) 계약 검사.
// `npx tsx server/routes/conversations.regenerate.test.ts` 로 돈다.
//
// 확인하려는 것.
//   1. 다시 생성: 마지막 답을 버리고 같은 질문(같은 id)으로 턴을 다시 돌린다 —
//      모델에 가는 기록에 버린 답이 없고, 저장된 대화에도 새 답 하나만 남는다.
//   2. 편집: 마지막 사용자 메시지의 내용만 바뀌고(id 유지), 바뀐 내용으로 돈다.
//   3. 사용자 메시지가 없는 대화는 400 이다.
//   4. 다른 턴이 흐르는 중이면 409 이고, 그 턴의 기록은 건드리지 않는다.
//   5. 이전 대화 요약: 이 질문 앞까지만 덮는 요약은 남고, 이 질문 이후까지
//      덮거나 끊는 지점이 사라진 요약은 버린다.
//   6. 새 대화의 기본 제목은 '새 대화' 이고, 첫 메시지가 오면 이름이 붙는다.
//   7. 첫 답이 오는 사이 사용자가 바꾼 제목은, 늦게 도착한 요약 제목이 덮지 않는다.
//   8. 답의 사용량은 그 질문 때문에 쓴 전체다 — 제목 짓기 호출도, 답이 저장된 뒤에
//      끝난 호출도 그 답에 더해진다.
//
// conversations.answerNow.test.ts 와 같은 방식이다: 라우트를 실제로 띄우고
// vLLM 만 가짜로 바꾼다.
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

/* --------------------------------------------------------- 환경 설정 (import 전) */
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regenerate-route-test-"));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
process.env.FEEDBACK_DETECT = "false";

/* ------------------------------------------------------------------ 가짜 vLLM */
const MODEL = "model-x";
const WINDOW = 50_000;

let answerCount = 0;
/** 메인 라운드마다 모델이 받은 메시지 목록(검사가 들여다본다). */
const mainRoundPrompts: Array<Array<{ role?: string; content?: unknown }>> = [];
/** 설정되면 다음 메인 라운드는 이 약속이 풀릴 때까지 답하지 않는다. */
let holdNextMainRound: { started: () => void; release: Promise<void> } | null = null;
/** 설정되면 다음 제목 요약 호출은 이 약속이 풀릴 때까지 답하지 않는다. */
let holdNextTitle: { asked: () => void; release: Promise<void> } | null = null;

function sseResponse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
  }
  return "";
}

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (!url.startsWith("http://mock-vllm/")) return realFetch(input as never, init);

  if (method === "GET" && url.endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: MODEL, max_model_len: WINDOW }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");

  if (method === "POST" && url.endsWith("/tokenize")) {
    return new Response(JSON.stringify({ count: Math.ceil(JSON.stringify(body.messages ?? []).length / 4), max_model_len: WINDOW }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (method === "POST" && url.endsWith("/chat/completions")) {
    if ((body.stream === false || body.tools === undefined) && holdNextTitle) {
      const hold = holdNextTitle;
      holdNextTitle = null;
      hold.asked();
      await hold.release;
    }
    // 제목 요약 같은 곁가지 호출.
    if (body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "요약 제목" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // 제목 요약도 스트림으로 온다 — 도구를 싣지 않은 호출은 곁가지다.
    if (body.tools === undefined) {
      return sseResponse([
        { choices: [{ delta: { content: "요약 제목" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
      ]);
    }
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    mainRoundPrompts.push(messages);
    const question = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
    if (holdNextMainRound) {
      const hold = holdNextMainRound;
      holdNextMainRound = null;
      hold.started();
      await hold.release;
    }
    answerCount++;
    return sseResponse([
      { choices: [{ delta: { content: `답변 ${answerCount}: ${question}` }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
    ]);
  }

  throw new Error(`이 검사가 예상하지 못한 요청: ${method} ${url}`);
}) as typeof fetch;

/* -------------------------------------------------------------------- 준비 */
const { conversationsRouter } = await import("./conversations.js");
const { createConversation, getConversation, saveHistorySummary } = await import("../storage/conversationStore.js");

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

interface TurnResult {
  status: number;
  events: Array<Record<string, any>>;
  json: Record<string, any> | null;
}

async function post(id: string, body: unknown): Promise<TurnResult> {
  const res = await fetch(`${base}/conversations/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return { status: res.status, events: [], json: JSON.parse(text) };
  }
  const events = text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l) && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(5).trim()));
  return { status: res.status, events, json: null };
}

const doneOf = (r: TurnResult) => r.events.find((e) => e.type === "done")?.message;
const userOf = (r: TurnResult) => r.events.find((e) => e.type === "user_message")?.message;
const promptMentions = (prompt: Array<{ content?: unknown }> | undefined, needle: string) =>
  (prompt ?? []).some((m) => textOf(m.content).includes(needle));

console.log("server/routes/conversations.ts — POST /conversations/:id/messages {regenerate}");

/* ------------------------------------------------------- 6) 기본 제목 '새 대화' */
const conv = await createConversation("alice", { model: MODEL });
check("새 대화의 기본 제목은 '새 대화' 다", conv.title === "새 대화", conv.title);

const first = await post(conv.id, { content: "첫 질문" });
check("보통 전송은 200 스트림이다", first.status === 200, String(first.status));
const firstUser = userOf(first);
check("첫 답이 저장된다", doneOf(first)?.content === "답변 1: 첫 질문", JSON.stringify(doneOf(first)));
{
  const stored = await getConversation("alice", conv.id);
  check("첫 메시지로 기본 제목이 바뀐다", stored?.title !== "새 대화", stored?.title);
  const answer = stored?.messages.find((m) => m.role === "assistant");
  check(
    "첫 답의 사용량에 제목 짓기 호출(입력 7·출력 3)도 들어간다",
    answer?.usage?.totalTokens === 20 && answer.usage.promptTokens === 12 && answer.usage.completionTokens === 8,
    JSON.stringify(answer?.usage),
  );
}

/* ------------------------------------------------------------------ 1) 다시 생성 */
{
  const r = await post(conv.id, { regenerate: true });
  check("다시 생성은 200 스트림이다", r.status === 200, String(r.status) + JSON.stringify(r.json));
  const user = userOf(r);
  check("user_message 는 같은 메시지(같은 id·내용)를 다시 알린다", user?.id === firstUser?.id && user?.content === "첫 질문", JSON.stringify(user));
  check("새 답으로 다시 돈다", doneOf(r)?.content === "답변 2: 첫 질문", JSON.stringify(doneOf(r)));
  check("모델에 가는 기록에 버린 답이 없다", !promptMentions(mainRoundPrompts.at(-1), "답변 1"), JSON.stringify(mainRoundPrompts.at(-1)));
  const stored = await getConversation("alice", conv.id);
  const shape = stored?.messages.map((m) => `${m.role}:${m.content}`);
  check(
    "저장된 대화는 질문 하나와 새 답 하나뿐이다",
    JSON.stringify(shape) === JSON.stringify(["user:첫 질문", "assistant:답변 2: 첫 질문"]),
    JSON.stringify(shape),
  );
}

/* ----------------------------------------------------------------- 2) 편집 재전송 */
{
  const r = await post(conv.id, { regenerate: true, content: "고친 질문" });
  check("편집 재전송은 200 스트림이다", r.status === 200, String(r.status) + JSON.stringify(r.json));
  const user = userOf(r);
  check("user_message 는 id 를 유지하고 내용만 바뀐다", user?.id === firstUser?.id && user?.content === "고친 질문", JSON.stringify(user));
  check("바뀐 내용으로 돈다", doneOf(r)?.content === "답변 3: 고친 질문", JSON.stringify(doneOf(r)));
  check("모델에 옛 질문이 가지 않는다", !promptMentions(mainRoundPrompts.at(-1), "첫 질문"), JSON.stringify(mainRoundPrompts.at(-1)));
  const stored = await getConversation("alice", conv.id);
  const shape = stored?.messages.map((m) => `${m.role}:${m.content}`);
  check(
    "저장된 질문이 고친 내용으로 바뀌었다",
    JSON.stringify(shape) === JSON.stringify(["user:고친 질문", "assistant:답변 3: 고친 질문"]),
    JSON.stringify(shape),
  );
  const again = await post(conv.id, { regenerate: true, content: "   " });
  check("공백뿐인 content 는 편집이 아니라 그대로 다시 생성이다", userOf(again)?.content === "고친 질문", JSON.stringify(userOf(again)));
}

/* ------------------------------------------------- 3) 사용자 메시지가 없으면 400 */
{
  const empty = await createConversation("alice", { model: MODEL });
  const r = await post(empty.id, { regenerate: true });
  check("사용자 메시지가 없으면 400", r.status === 400, String(r.status));
  check("  └ code no_user_message", r.json?.code === "no_user_message", JSON.stringify(r.json));
  const stored = await getConversation("alice", empty.id);
  check("  └ 대화는 그대로 비어 있다", stored?.messages.length === 0, JSON.stringify(stored?.messages));
  const missing = await post("00000000-0000-4000-8000-000000000000", { regenerate: true });
  check("없는 대화는 404", missing.status === 404, String(missing.status));
}

/* ---------------------------------------------- 4) 다른 턴이 흐르는 중이면 409 */
{
  let started!: () => void;
  const isStarted = new Promise<void>((r) => (started = r));
  let release!: () => void;
  holdNextMainRound = { started, release: new Promise<void>((r) => (release = r)) };
  const inFlight = post(conv.id, { content: "두 번째 질문" });
  await isStarted;
  const r = await post(conv.id, { regenerate: true });
  check("턴이 흐르는 중에 다시 생성하면 409", r.status === 409, String(r.status) + JSON.stringify(r.json));
  release();
  const finished = await inFlight;
  check("흐르던 턴은 그대로 끝난다", doneOf(finished)?.content?.endsWith("두 번째 질문"), JSON.stringify(doneOf(finished)));
  const stored = await getConversation("alice", conv.id);
  check("  └ 기록은 네 개 그대로다", stored?.messages.length === 4, JSON.stringify(stored?.messages.map((m) => m.role)));
}

/* --------------------------------------------------------------- 5) 요약 처리 */
{
  // 지금 대화: [user 고친 질문, assistant, user 두 번째 질문, assistant]
  const before = await getConversation("alice", conv.id);
  const [m0, m1, m2] = before!.messages;
  const summary = (throughMessageId: string, coveredMessages: number) => ({
    text: "앞선 대화 요약",
    throughMessageId,
    coveredMessages,
    createdAt: new Date().toISOString(),
  });

  await saveHistorySummary("alice", conv.id, summary(m1!.id, 2));
  await post(conv.id, { regenerate: true });
  let stored = await getConversation("alice", conv.id);
  check("이 질문 앞까지만 덮는 요약은 남는다", stored?.historySummary?.throughMessageId === m1!.id, JSON.stringify(stored?.historySummary));

  await saveHistorySummary("alice", conv.id, summary(m2!.id, 3));
  await post(conv.id, { regenerate: true });
  stored = await getConversation("alice", conv.id);
  check("이 질문까지 덮는 요약은 버린다", stored?.historySummary === undefined, JSON.stringify(stored?.historySummary));

  await saveHistorySummary("alice", conv.id, summary("no-such-message", 1));
  await post(conv.id, { regenerate: true });
  stored = await getConversation("alice", conv.id);
  check("끊는 지점이 없는 요약은 버린다", stored?.historySummary === undefined, JSON.stringify(stored?.historySummary));
  check("  └ 기록 앞부분은 그대로다", stored?.messages[0]?.id === m0!.id && stored?.messages.length === 4, String(stored?.messages.length));
}

/* ------------------------------- 7) 첫 답 도중에 바꾼 제목은 요약 제목이 덮지 않는다 */
{
  let asked!: () => void;
  const titleAsked = new Promise<void>((r) => (asked = r));
  let release!: () => void;
  holdNextTitle = { asked, release: new Promise<void>((r) => (release = r)) };

  const fresh = await createConversation("alice", { model: MODEL });
  await post(fresh.id, { content: "제목을 지을 질문" });
  await titleAsked;
  const renamed = await fetch(`${base}/conversations/${fresh.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "내가 지은 제목" }),
  });
  check("제목 바꾸기는 200", renamed.status === 200, String(renamed.status));
  const before = (await getConversation("alice", fresh.id))!.updatedAt;
  release();
  // 요약 제목을 반영하려는 쓰기가 끝나면 updatedAt 이 바뀐다 — 그때까지 기다린다.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if ((await getConversation("alice", fresh.id))?.updatedAt !== before) break;
  }
  const stored = await getConversation("alice", fresh.id);
  check("사용자가 바꾼 제목이 남는다", stored?.title === "내가 지은 제목", stored?.title);
  const answer = stored?.messages.find((m) => m.role === "assistant");
  check("답이 저장된 뒤에 끝난 제목 호출의 사용량도 그 답에 더해진다", answer?.usage?.totalTokens === 20, JSON.stringify(answer?.usage));
}

server.close();

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
