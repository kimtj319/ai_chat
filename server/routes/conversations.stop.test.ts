// 멈춘 답과, 다시 생성·편집 재전송이 아무것도 못 만들었을 때의 계약 검사.
// `npx tsx server/routes/conversations.stop.test.ts` 로 돈다.
//
// 확인하려는 것.
//   1. 사용자가 멈춘 답은 오류가 아니라 "멈춤"(stopped)으로 저장된다 — 받은 데까지의
//      글은 남고 error 는 없다. 새로 고쳐 열어도 실패 카드가 뜨지 않게.
//   2. 다시 생성을 첫 글자가 오기 전에 멈추면, 지웠던 이전 답이 그대로 돌아온다
//      (`restored` 이벤트, 저장된 대화도 원래대로).
//   3. 편집 재전송이 모델 오류로 실패해도 이전 질문·답이 돌아온다.
//   4. 다시 생성이 글을 조금이라도 만든 뒤 멈추면 그 새 답(멈춤)을 남긴다.
//
// conversations.regenerate.test.ts 와 같은 방식이다: 라우트를 실제로 띄우고
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
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "stop-route-test-"));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
process.env.FEEDBACK_DETECT = "false";

/* ------------------------------------------------------------------ 가짜 vLLM */
const MODEL = "model-x";
const WINDOW = 50_000;

/**
 * 다음 메인 라운드가 어떻게 답할지.
 *   answer  — 끝까지 답한다.
 *   partial — 글 한 조각을 보내고, 멈출 때까지 붙든다.
 *   silent  — 아무것도 보내지 않고, 멈출 때까지 붙든다.
 *   fail    — 500 으로 실패한다.
 */
let nextMode: "answer" | "partial" | "silent" | "fail" = "answer";
/** 붙드는 라운드가 시작되면 불린다(검사가 그때 멈춤을 누른다). */
let onHeld: (() => void) | null = null;
let answerCount = 0;

const encoder = new TextEncoder();
const frame = (chunk: unknown) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
const abortError = () => Object.assign(new Error("aborted-by-test"), { name: "AbortError" });

function sseResponse(chunks: unknown[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(frame(c));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 첫 조각(있으면)을 보내고, 신호가 끊을 때까지 스트림을 열어 둔다. */
function heldResponse(signal: AbortSignal | undefined, first: unknown | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first) controller.enqueue(frame(first));
      const stop = () => controller.error(abortError());
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
      // 첫 조각이 서버에 닿을 틈을 둔 뒤에 검사에게 알린다.
      setTimeout(() => onHeld?.(), 50);
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
    // 제목 요약 같은 곁가지 호출.
    if (body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "요약 제목" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (body.tools === undefined) {
      return sseResponse([{ choices: [{ delta: { content: "요약 제목" }, finish_reason: "stop" }] }]);
    }
    const mode = nextMode;
    nextMode = "answer";
    const signal = init?.signal as AbortSignal | undefined;
    if (mode === "fail") {
      return new Response("upstream exploded", { status: 500 });
    }
    if (mode === "partial") {
      return heldResponse(signal, { choices: [{ delta: { content: "부분 답" }, finish_reason: null }] });
    }
    if (mode === "silent") {
      return heldResponse(signal, null);
    }
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    const question = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
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
const { createConversation, getConversation } = await import("../storage/conversationStore.js");

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
}

async function post(id: string, body: unknown): Promise<TurnResult> {
  const res = await fetch(`${base}/conversations/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l) && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(5).trim()));
  return { status: res.status, events };
}

/** 붙드는 라운드로 턴을 보내고, 라운드가 시작되면 멈춤(DELETE …/stream)을 누른다. */
async function postAndStop(id: string, body: unknown, mode: "partial" | "silent"): Promise<TurnResult> {
  nextMode = mode;
  const held = new Promise<void>((resolve) => (onHeld = resolve));
  const turn = post(id, body);
  await held;
  onHeld = null;
  const stop = await fetch(`${base}/conversations/${id}/stream`, { method: "DELETE" });
  check(`  └ 멈춤은 204 (${mode})`, stop.status === 204, String(stop.status));
  return turn;
}

const doneOf = (r: TurnResult) => r.events.find((e) => e.type === "done")?.message;
const shapeOf = async (id: string) =>
  (await getConversation("alice", id))?.messages.map((m) => `${m.role}:${m.content}${m.stopped ? "(멈춤)" : ""}${m.error ? `(오류:${m.error})` : ""}`);

console.log("server/routes/conversationTurn.ts — 멈춤과 다시 생성의 복원");

/* --------------------------------------------- 1) 멈춘 답은 오류가 아니라 멈춤 */
const conv = await createConversation("alice", { model: MODEL });
{
  const r = await postAndStop(conv.id, { content: "첫 질문" }, "partial");
  const done = doneOf(r);
  check("멈춘 답의 done 은 받은 데까지의 글을 담는다", done?.content === "부분 답", JSON.stringify(done));
  check("멈춘 답은 stopped 로 표시된다", done?.stopped === true, JSON.stringify(done));
  check("멈춘 답에는 error 가 없다", done?.error === undefined, JSON.stringify(done));
  const stored = (await getConversation("alice", conv.id))?.messages.at(-1);
  check("저장된 답도 stopped 이고 error 가 없다", stored?.stopped === true && stored?.error === undefined, JSON.stringify(stored));
}

/* ------------------------------- 2) 첫 글자 전에 멈춘 다시 생성은 이전 답을 돌려놓는다 */
{
  // 먼저 온전한 답을 하나 만든다.
  const ok = await post(conv.id, { regenerate: true });
  const complete = doneOf(ok)?.content as string;
  check("다시 생성으로 온전한 답이 생긴다", complete?.startsWith("답변 "), JSON.stringify(doneOf(ok)));
  const before = await shapeOf(conv.id);

  const r = await postAndStop(conv.id, { regenerate: true }, "silent");
  check("첫 글자 전에 멈추면 restored 를 보낸다", r.events.some((e) => e.type === "restored"), JSON.stringify(r.events.map((e) => e.type)));
  check("  └ 새 답을 done 으로 보내지 않는다", doneOf(r) === undefined, JSON.stringify(doneOf(r)));
  const after = await shapeOf(conv.id);
  check("저장된 대화는 다시 생성 전과 같다", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

/* ------------------------------------- 3) 실패한 편집 재전송은 이전 질문·답을 돌려놓는다 */
{
  const before = await shapeOf(conv.id);
  nextMode = "fail";
  const r = await post(conv.id, { regenerate: true, content: "고친 질문" });
  const types = r.events.map((e) => e.type);
  check("실패하면 restored 뒤에 error 를 보낸다", types.indexOf("restored") >= 0 && types.indexOf("restored") < types.indexOf("error"), JSON.stringify(types));
  const after = await shapeOf(conv.id);
  check("저장된 대화는 편집 전과 같다(질문도 원래 글)", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

/* ------------------------------------- 4) 글을 만든 뒤 멈춘 다시 생성은 새 답을 남긴다 */
{
  const r = await postAndStop(conv.id, { regenerate: true }, "partial");
  check("글이 온 뒤 멈추면 restored 가 없다", !r.events.some((e) => e.type === "restored"), JSON.stringify(r.events.map((e) => e.type)));
  const after = await shapeOf(conv.id);
  check(
    "저장된 대화는 질문과 새 부분 답(멈춤)이다",
    JSON.stringify(after) === JSON.stringify(["user:첫 질문", "assistant:부분 답(멈춤)"]),
    JSON.stringify(after),
  );
}

/* ------------------------------------- 5) 보통 전송은 실패해도 아무것도 돌려놓지 않는다 */
{
  nextMode = "fail";
  const r = await post(conv.id, { content: "새 질문" });
  check("보통 전송의 실패에는 restored 가 없다", !r.events.some((e) => e.type === "restored"), JSON.stringify(r.events.map((e) => e.type)));
  const after = await shapeOf(conv.id);
  check("  └ 보낸 질문은 남는다", after?.at(-1) === "user:새 질문", JSON.stringify(after));
}

server.close();

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
