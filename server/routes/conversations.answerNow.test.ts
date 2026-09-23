// "지금 답변하기" 엔드포인트(POST /api/conversations/:id/answer-now) 계약 검사.
// `npx tsx server/routes/conversations.answerNow.test.ts` 로 돈다.
// (server 쪽 계약 검사와 나란히 있지만 npm test 스크립트에는 아직 없다 — 손으로
// 이 경로를 불러서 확인한다.)
//
// 확인하려는 것 넷.
//   1. 남의 대화에는 신호를 보낼 수 없다(404 — 존재 여부도 흘리지 않는다).
//   2. 진행 중인 턴이 없으면 무해하다(404, 서버가 죽지 않는다).
//   3. 진행 중인 턴에 보내면: 실제로 vLLM 에 나가 있던 요청이 끊기고, 도구
//      호출 없이 마무리 답변으로 넘어가며, "취소됨" 이 아니라 정상 종료로
//      기록된다 — toolLoop.test.ts 의 시나리오 D 가 함수 수준에서 보는 것과
//      같은 계약을, 실제 HTTP 라우트를 통해서 다시 본다.
//   4. 턴이 끝난 뒤 같은 신호를 다시 보내도 무해하다(추적 맵이 정리됐다).
//
// board.test.ts 의 "라우트를 실제로 띄워서 본다" 방식과, toolLoop.test.ts 의
// "가짜 vLLM" 방식을 그대로 합친다.
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
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "answer-now-route-test-"));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
process.env.ANSWER_NOW_THRESHOLD_MS = "1000"; // 검사 자체는 이 값을 기다리지 않는다 — SSE 로 그대로 오는지만 본다.

/* ------------------------------------------------------------------ 가짜 vLLM */
const MODEL = "model-x";
const WINDOW = 50_000;

/** 첫 메인 라운드 요청을 "지금 답변하기" 가 실제로 끊을 때까지 붙들어 둔다. */
let onMainRoundInFlight: (() => void) | null = null;

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

function lastMessageContent(body: { messages?: Array<{ content?: unknown }> }): string {
  const last = body.messages?.[body.messages.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

// 이 안에서 우리 express 서버(127.0.0.1) 로도 호출을 낸다(answer-now 를 실제
// HTTP 로 누르기 위해서) — 그건 가짜 vLLM 이 아니라 진짜로 나가야 하므로,
// vLLM 쪽 주소가 아니면 원래 fetch 로 넘긴다.
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (!url.startsWith("http://mock-vllm/")) {
    return realFetch(input as never, init);
  }

  if (method === "GET" && url.endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: MODEL, max_model_len: WINDOW }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const raw = typeof init?.body === "string" ? init.body : "{}";
  const body = JSON.parse(raw);

  if (method === "POST" && url.endsWith("/tokenize")) {
    return new Response(JSON.stringify({ count: Math.ceil(JSON.stringify(body.messages ?? []).length / 4), max_model_len: WINDOW }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (method === "POST" && url.endsWith("/chat/completions")) {
    if (body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // 마무리(wrap-up) 호출: streamWrapUpAnswer 는 tools 를 아예 안 실어 보낸다.
    if (body.tools === undefined) {
      return sseResponse([
        { choices: [{ delta: { content: "지금까지 조사한 내용으로 답변을 정리했습니다." }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
      ]);
    }
    // 메인 라운드: 딱 한 번, "지금 답변하기" 가 끊을 때까지 응답하지 않는다.
    if (onMainRoundInFlight) {
      const hook = onMainRoundInFlight;
      onMainRoundInFlight = null;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const onAbort = () => reject(Object.assign(new Error("aborted-by-test"), { name: "AbortError" }));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        hook();
      });
    }
    throw new Error(`이 검사가 예상하지 못한 메인 라운드 호출: ${lastMessageContent(body).slice(0, 100)}`);
  }

  throw new Error(`이 검사가 예상하지 못한 요청: ${method} ${url}`);
}) as typeof fetch;

/* -------------------------------------------------------------------- 준비 */
const { conversationsRouter } = await import("./conversations.js");
const { createConversation } = await import("../storage/conversationStore.js");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.ownerId = String(req.headers["x-as"] ?? "alice");
  next();
});
app.use("/api", conversationsRouter);

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api`;

async function answerNow(as: string, id: string): Promise<number> {
  const res = await fetch(`${base}/conversations/${id}/answer-now`, { method: "POST", headers: { "x-as": as } });
  return res.status;
}

console.log("server/routes/conversations.ts — POST /conversations/:id/answer-now");

const alice = await createConversation("alice", { model: MODEL });

/* --------------------------------------------------- 1) 남의 대화는 못 건드린다 */
{
  const status = await answerNow("bob", alice.id);
  check("남의 대화면 404 다(있는지도 안 흘린다)", status === 404, String(status));
}

/* ------------------------------------------------- 2) 진행 중인 턴이 없으면 무해 */
{
  const status = await answerNow("alice", alice.id);
  check("진행 중인 턴이 없으면 404 지만 서버는 멀쩡하다", status === 404, String(status));
}

/* --------------------------------- 3) 진행 중인 턴을 실제로 마무리로 넘긴다 */
{
  let requestedAnswerNowStatus: number | null = null;
  onMainRoundInFlight = () => {
    // 이 시점엔 abort 리스너가 이미 걸려 있다(위에서 등록한 다음 호출) — 지금
    // 눌러야 "진행 중이던 호출을 끊는다" 는 실제 상황이 재현된다.
    void answerNow("alice", alice.id).then((s) => {
      requestedAnswerNowStatus = s;
    });
  };

  const res = await fetch(`${base}/conversations/${alice.id}/messages`, {
    method: "POST",
    headers: { "x-as": "alice", "content-type": "application/json" },
    body: JSON.stringify({ content: "오래 걸리는 질문입니다" }),
  });
  check("메시지 전송 자체는 200 스트림으로 시작한다", res.status === 200, String(res.status));
  const text = await res.text();

  const events = text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l) && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(5).trim()));

  check(
    "answer-now 요청 자체는 204 로 받아들여졌다",
    requestedAnswerNowStatus === 204,
    String(requestedAnswerNowStatus),
  );

  const turnStarted = events.find((e) => e.type === "turn_started");
  check(
    "turn_started 이벤트가 서버 설정값(ANSWER_NOW_THRESHOLD_MS)을 실어 온다",
    turnStarted?.answerNowAfterMs === 1000,
    JSON.stringify(turnStarted),
  );

  const notice = events.find((e) => e.type === "notice" && typeof e.message === "string" && e.message.includes("지금 답변하기"));
  check("'지금 답변하기' 사유의 안내가 스트림에 온다", Boolean(notice), JSON.stringify(events.map((e) => e.type)));

  const done = events.find((e) => e.type === "done");
  check("done 이벤트가 온다(스트림이 에러 없이 끝난다)", Boolean(done), JSON.stringify(events.map((e) => e.type)));
  check(
    "최종 답변은 마무리 호출의 내용이다(취소가 아니다)",
    done?.message?.content === "지금까지 조사한 내용으로 답변을 정리했습니다.",
    JSON.stringify(done?.message),
  );
  check("최종 메시지에 error 가 없다", !done?.message?.error, JSON.stringify(done?.message?.error));
  check(
    "도구 호출은 하나도 기록되지 않았다",
    !done?.message?.toolCalls || done.message.toolCalls.length === 0,
    JSON.stringify(done?.message?.toolCalls),
  );
}

/* ------------------------------------------- 4) 끝난 턴에 다시 보내도 무해하다 */
{
  const status = await answerNow("alice", alice.id);
  check("턴이 끝난 뒤 다시 보내도 404 일 뿐 무해하다(추적이 정리됐다)", status === 404, String(status));
}

server.close();

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
