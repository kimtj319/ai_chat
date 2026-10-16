// 크롬 도구(사용자의 브라우저에서 실행되는 도구) 계약 검사. `npm test` 로 돈다.
//
// 확인하려는 것:
//   1. 크롬 도구는 그 턴이 browserControl 을 켰을 때만 모델에게 보인다.
//   2. 호출은 서버에서 실행되지 않고 browser_action 이벤트로 나간 뒤, 돌아온 결과가
//      도구 결과가 되어 모델에게 간다.
//   3. 결과는 그 계정·대화의 것만 받는다.
//   4. 중지하면 기다림이 바로 끝나고, 아무도 답하지 않으면 시간이 다 돼 끝난다.
//   5. 같은 스크롤을 여러 번 부르는 것은 보통 도구보다 넉넉히 허용한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-browser-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
process.env.REASONING_PROFILES = "";

const { runConversationTurn } = await import("./toolLoop.js");
const { startBrowserAction, completeBrowserAction } = await import("./browserBridge.js");
const { browserRouter } = await import("../routes/browser.js");
const { DEFAULT_SETTINGS } = await import("../types.js");
type Conversation = import("../types.js").Conversation;
type ChatEvent = import("./toolLoop.js").ChatEvent;

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

console.log("server/chat/browserBridge.ts + tools/browser.ts + toolLoop 의 크롬 도구 경로");

/* ---------------------------------------------------------------- 가짜 vLLM */

type Answer = { content?: string; toolCall?: { name: string; arguments: unknown } };
let script: Answer[] = [];
let round = 0;
const seenRequests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }> = [];

function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("http://mock-vllm")) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "mock-model", max_model_len: 200000 }] }), { status: 200 });
  }
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  if (url.endsWith("/tokenize")) {
    return new Response(JSON.stringify({ count: 100, max_model_len: 200000 }), { status: 200 });
  }
  if (url.endsWith("/chat/completions")) {
    seenRequests.push(body);
    const answer = script[round++] ?? { content: "끝" };
    if (answer.toolCall) {
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: `call_${round}`, type: "function", function: { name: answer.toolCall.name, arguments: JSON.stringify(answer.toolCall.arguments) } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]);
    }
    return sse([
      { choices: [{ delta: { content: answer.content ?? "" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
  }
  throw new Error(`unexpected request ${method} ${url}`);
}) as typeof fetch;

function conversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: "conv-1",
    title: "t",
    systemPrompt: "",
    model: "mock-model",
    settings: { ...DEFAULT_SETTINGS },
    enabledTools: ["calculator"],
    messages: [{ id: "u1", role: "user", content: "example.com 을 열어 줘", createdAt: now }],
    createdAt: now,
    updatedAt: now,
  } as Conversation;
}

/**
 * 턴 하나를 끝까지 돌린다. browser_action 이 나오면 respond 로 답한다(브라우저 흉내).
 */
async function runTurn(
  browserControl: boolean,
  respond: (event: Extract<ChatEvent, { type: "browser_action" }>) => void,
  controller = new AbortController(),
) {
  const events: ChatEvent[] = [];
  const gen = runConversationTurn(conversation(), "owner-1", controller.signal, new AbortController().signal, { browserControl });
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
    if (step.value.type === "browser_action") respond(step.value);
  }
}

/* ------------------------------------------------------------------ 1. 노출 */

{
  script = [{ toolCall: { name: "browser_open", arguments: { url: "https://example.com" } } }, { content: "못 했습니다" }];
  round = 0;
  seenRequests.length = 0;
  const { events, result } = await runTurn(false, () => {});
  const offered = (seenRequests[0]?.tools ?? []).map((t) => t.function.name);
  check("꺼져 있으면 크롬 도구를 싣지 않는다", !offered.some((n) => n.startsWith("browser_")), offered.join(","));
  check("…부르면 모르는 도구로 거절된다", result.toolResults[0]?.error?.startsWith("Unknown tool"), JSON.stringify(result.toolResults));
  check("…브라우저로 아무것도 보내지 않는다", !events.some((e) => e.type === "browser_action"));
}

/* ------------------------------------------------------------- 2. 왕복 */

{
  script = [{ toolCall: { name: "browser_open", arguments: { url: "https://example.com" } } }, { content: "제목은 Example Domain 입니다." }];
  round = 0;
  seenRequests.length = 0;
  let wrongOwner: boolean | null = null;
  const { events, result } = await runTurn(true, (event) => {
    wrongOwner = completeBrowserAction("someone-else", "conv-1", event.callId, { ok: true, result: "가로채기" });
    // 실제 브라우저처럼 조금 뒤에 답한다.
    setTimeout(() => completeBrowserAction("owner-1", "conv-1", event.callId, { ok: true, result: "[탭 1] Example Domain" }), 20);
  });
  const offered = (seenRequests[0]?.tools ?? []).map((t) => t.function.name);
  check("켜져 있으면 크롬 도구 7개를 싣는다", offered.filter((n) => n.startsWith("browser_")).length === 7, offered.join(","));
  const action = events.find((e) => e.type === "browser_action");
  check("browser_action 이벤트가 나간다", action && action.type === "browser_action" && action.name === "browser_open" && action.toolCallId === "call_1");
  check("다른 계정의 결과는 받지 않는다", wrongOwner === false);
  check("브라우저의 결과가 도구 결과가 된다", result.toolResults[0]?.ok === true && result.toolResults[0]?.result === "[탭 1] Example Domain");
  const toolMessage = seenRequests[1]?.messages.find((m) => m.role === "tool");
  check("…그리고 모델에게 간다", typeof toolMessage?.content === "string" && toolMessage.content.includes("Example Domain"));
  check("턴이 답으로 끝난다", result.content === "제목은 Example Domain 입니다.");
}

/* --------------------------------------------------------------- 3. 실패 결과 */

{
  script = [{ toolCall: { name: "browser_click", arguments: { ref: "e3" } } }, { content: "취소됐습니다." }];
  round = 0;
  const { result } = await runTurn(true, (event) =>
    completeBrowserAction("owner-1", "conv-1", event.callId, { ok: false, error: "사용자가 이 동작을 허용하지 않았습니다." }),
  );
  check("거절된 동작은 오류 결과로 모델에게 간다", result.toolResults[0]?.ok === false && result.toolResults[0]?.error?.includes("허용하지"));
}

/* --------------------------------------------------------------- 4. 중지·시간 초과 */

{
  script = [{ toolCall: { name: "browser_read", arguments: {} } }, { content: "x" }];
  round = 0;
  const controller = new AbortController();
  const started = Date.now();
  const { result } = await runTurn(true, () => setTimeout(() => controller.abort(), 30), controller);
  check("기다리는 중 중지하면 바로 끝난다", Date.now() - started < 3000 && result.error === "Cancelled by client.", `${Date.now() - started}ms ${result.error}`);

  const timed = startBrowserAction("owner-1", "conv-1", new AbortController().signal, 50);
  // 서버의 대기 타이머는 unref 라(프로세스를 붙잡지 않는다) 시험 프로세스는 따로 붙잡아 둔다.
  const keepAlive = setTimeout(() => {}, 1000);
  const outcome = await timed.result;
  clearTimeout(keepAlive);
  check("아무도 답하지 않으면 시간이 다 돼 끝난다", outcome.ok === false && outcome.error?.includes("응답하지"));
  check("끝난 호출에는 결과를 넣을 수 없다", completeBrowserAction("owner-1", "conv-1", timed.callId, { ok: true }) === false);
}

/* --------------------------------------------------------------- 5. 반복 한도 */

{
  const scroll = { toolCall: { name: "browser_scroll", arguments: { direction: "down" } } };
  script = [scroll, scroll, scroll, scroll, scroll, { content: "다 봤습니다." }];
  round = 0;
  const { result } = await runTurn(true, (event) => completeBrowserAction("owner-1", "conv-1", event.callId, { ok: true, result: "page" }));
  check("같은 스크롤 5번은 모두 실행된다", result.toolResults.length === 5 && result.toolResults.every((r) => r.ok), JSON.stringify(result.toolResults.map((r) => r.ok)));
}

/* --------------------------------------------------------------- 6. 결과 받는 경로 */

{
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ownerId = String(req.headers["x-as"] ?? "owner-1");
    next();
  });
  app.use("/api", browserRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const post = (as: string, callId: string, body: unknown) =>
    realFetch(`http://127.0.0.1:${port}/api/conversations/conv-1/browser-actions/${callId}`, {
      method: "POST",
      headers: { "x-as": as, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const action = startBrowserAction("owner-1", "conv-1", new AbortController().signal);
  check("다른 계정은 404", (await post("intruder", action.callId, { ok: true, result: "x" })).status === 404);
  check("주인은 204", (await post("owner-1", action.callId, { ok: true, result: "페이지" })).status === 204);
  const outcome = await action.result;
  check("…결과가 그대로 전달된다", outcome.ok && outcome.result === "페이지");
  check("이미 끝난 호출은 404", (await post("owner-1", action.callId, { ok: true })).status === 404);

  const failed = startBrowserAction("owner-1", "conv-1", new AbortController().signal);
  await post("owner-1", failed.callId, { ok: false });
  const failedOutcome = await failed.result;
  check("오류 문구가 없으면 기본 문구를 채운다", failedOutcome.ok === false && failedOutcome.error === "브라우저 동작이 실패했습니다.");
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
