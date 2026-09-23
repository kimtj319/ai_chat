// needsSummary()/buildTurnHistory() 검사. `npx tsx server/chat/historySummary.test.ts` 로 돈다.
//
// 이 파일이 지키는 계약 두 가지(둘 다 과제 1·2에 걸쳐 있다):
//
// 1. 대화가 길어져 컨텍스트가 차면, 도구 호출을 멈추는 contextToolStopRatio 에
//    닿기 "전에" 이전 대화를 요약해 자리를 만들어야 한다. 예전에는 needsSummary
//    가 "요청이 아예 안 들어갈 때"(거의 100%)에만 참이었는데, 이는
//    contextToolStopRatio(기본 0.8)보다 한참 뒤라서 — 대화가 길어지면 도구가
//    멈춘 채로 매 턴 열리고, 요약은 그 뒤에도 한참 동안 기회를 못 얻었다.
// 2. 그 판단 자체가 매 턴 실제 /tokenize 왕복을 요구해서는 안 된다 — couldSummarise
//    가 참이 되는 순간부터(대화가 6개 메시지를 넘으면) 창이 실제로 찰 때까지
//    수십 턴이 걸릴 수 있는데, 그 사이 매 턴 "아직 멀었다"는 답을 듣기 위해서만
//    네트워크 왕복을 냈다. 문자 추정치가 이미 기준 미달이면(그리고 그 추정치는
//    실측상 진짜 토큰수보다 낮게 나온 적이 없으므로) 왕복 없이 안전하게 건너뛸
//    수 있어야 한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-historysummary-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.MODEL_CAPABILITY_PROBE = "0";

const { needsSummary, buildTurnHistory } = await import("./historySummary.js");
const { config } = await import("../config.js");
const { DEFAULT_SETTINGS } = await import("../types.js");

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

console.log("server/chat/historySummary.ts — needsSummary");

/** 4개는 그대로 남기고(KEEP_RECENT_MESSAGES) 앞에 2개 이상 새 메시지가 있어야
 * couldSummarise 가 참이 된다(MIN_NEW_MESSAGES) — 넉넉히 10개를 사용자/어시스턴트
 * 교대로 만든다. */
function longEnoughConversation(overrides: Partial<Record<string, unknown>> = {}) {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `메시지 ${i}`,
    createdAt: new Date().toISOString(),
  }));
  return {
    id: "conv-1",
    title: "test",
    systemPrompt: "",
    settings: { ...DEFAULT_SETTINGS },
    enabledTools: [],
    messages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

const WINDOW = 100_000;
const RATIO = config.contextToolStopRatio; // 기본 0.8 — 값 자체가 아니라 관계를 검사한다.
const desiredOutput = DEFAULT_SETTINGS.maxTokens;
// SAFETY_MARGIN_TOKENS 는 contextBudget.ts 에 있지만 여기서 다시 import 하지
// 않는다 — 하드 플로어 자체의 정확한 위치가 아니라 "비율 임계값이 하드
// 플로어보다 먼저 온다"만 검사하면 충분하고, 그 편이 두 상수의 값이 바뀌어도
// 깨지지 않는다.

/* ---------------------------------------------------- 비율 임계값(신규 동작) */

{
  const conv = longEnoughConversation();
  const justBelowRatio = Math.floor(WINDOW * RATIO) - 1;
  const justAboveRatio = Math.ceil(WINDOW * RATIO) + 1;

  check(
    "비율 바로 아래는 아직 요약하지 않는다",
    needsSummary(conv, justBelowRatio, WINDOW) === false,
  );
  check(
    "비율을 넘으면 하드 플로어에 한참 못 미쳐도 요약한다 (이게 이번 수정의 핵심)",
    needsSummary(conv, justAboveRatio, WINDOW) === true,
    `ratio*window=${WINDOW * RATIO}, tested=${justAboveRatio}, hard floor=${WINDOW - desiredOutput}`,
  );
}

/* -------------------------------------------------------------- 하드 플로어 */

{
  const conv = longEnoughConversation();
  // 하드 플로어: promptTokens + desiredOutput + SAFETY_MARGIN > window.
  // 비율 임계값이 무엇이든(설정으로 1에 가깝게 올리더라도) 이 지점은 항상 참이어야 한다.
  const atWindow = WINDOW - 1;
  check(
    "창을 거의 다 채우면(하드 플로어) 비율 설정과 무관하게 요약한다",
    needsSummary(conv, atWindow, WINDOW) === true,
  );
}

/* -------------------------------------------------------------------- 음성 */

{
  const conv = longEnoughConversation();
  check("여유가 많으면 요약하지 않는다", needsSummary(conv, Math.floor(WINDOW * 0.1), WINDOW) === false);
  check("창을 모르면(null) 요약하지 않는다 — 예산 계산 자체가 불가능", needsSummary(conv, WINDOW, null) === false);
}

{
  // couldSummarise 가 거짓인 경우: 새 메시지가 최소치(2)에 못 미친다.
  const conv = longEnoughConversation({
    messages: Array.from({ length: 4 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `메시지 ${i}`,
      createdAt: new Date().toISOString(),
    })),
  });
  check(
    "접을 새 메시지가 없으면(couldSummarise=false) 비율을 넘어도 요약하지 않는다",
    needsSummary(conv, Math.ceil(WINDOW * RATIO) + 1, WINDOW) === false,
  );
}

{
  // 이미 요약이 있고, 그 이후로 새 메시지가 거의 없는 경우도 같은 이유로 거짓.
  const conv = longEnoughConversation({
    historySummary: {
      text: "이전 요약",
      throughMessageId: "m5",
      coveredMessages: 6,
      createdAt: new Date().toISOString(),
    },
  });
  check(
    "요약 직후, 새 메시지가 아직 부족하면 다시 요약하지 않는다",
    needsSummary(conv, Math.ceil(WINDOW * RATIO) + 1, WINDOW) === false,
  );
}

/* ------------------------------------- buildTurnHistory: 불필요한 왕복 제거 */

console.log("");
console.log("server/chat/historySummary.ts — buildTurnHistory (문자 추정치로 /tokenize 왕복을 거른다)");

let tokenizeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.endsWith("/tokenize")) {
    tokenizeCalls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const tokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
    return new Response(JSON.stringify({ count: tokens, max_model_len: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`historySummary.test.ts 가 예상하지 못한 요청: ${url}`);
}) as typeof fetch;

const endpoint = { baseUrl: "http://mock-vllm/v1", label: "mock", apiKey: "" };

function longTextConversation(fillerCharsOnFirstMessage: number) {
  const conv = longEnoughConversation();
  (conv.messages[0] as { content: string }).content = "x".repeat(fillerCharsOnFirstMessage);
  return conv;
}

{
  tokenizeCalls = 0;
  // 채움 없이도 시스템 프롬프트 + 몇 줄이면 창(20,000)의 10%도 안 된다 —
  // 문자 추정치만으로 "필요 없음"이 확실하므로 /tokenize 를 아예 부르지 않아야 한다.
  const conv = longTextConversation(0);
  const history = await buildTurnHistory({
    conversation: conv,
    ownerId: "owner-1",
    model: "m",
    endpoint,
    contextWindow: 20_000,
    signal: new AbortController().signal,
  });
  check("여유가 많은 대화는 /tokenize 를 한 번도 부르지 않는다", tokenizeCalls === 0, String(tokenizeCalls));
  check("그리고 당연히 요약도 하지 않는다", history.notice === undefined);
}

{
  tokenizeCalls = 0;
  // 이번엔 정말 창을 넘긴다 — 추정치 관문을 통과해 실제 /tokenize 를 부르고,
  // 실제로 요약까지 일어나야 한다(안전장치가 진짜 필요할 때는 여전히 작동한다).
  const WINDOW = 5_000;
  const messages = longEnoughConversation().messages;
  const filler = "x".repeat(Math.ceil(WINDOW * 1.5)); // 넉넉히 창을 넘긴다
  (messages[0] as { content: string }).content = filler;
  const bigConv = longEnoughConversation({ messages });

  // 요약 호출 자체도 흉내 낸다: /chat/completions 로 온 요청은 무엇이든 200 OK.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/chat/completions")) {
      const text =
        "data: " +
        JSON.stringify({ choices: [{ delta: { content: "1. 대화 주제: 테스트\n2. 확인된 사실과 결정: 없음\n3. 요청과 답변: 없음\n4. 남은 것: 없음" }, finish_reason: "stop" }] }) +
        "\n\ndata: [DONE]\n\n";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;

  const history = await buildTurnHistory({
    conversation: bigConv,
    ownerId: "owner-1",
    model: "m",
    endpoint,
    contextWindow: WINDOW,
    signal: new AbortController().signal,
  });
  check("창을 실제로 넘기면 /tokenize 를 부른다(안전장치가 살아있다)", tokenizeCalls === 1, String(tokenizeCalls));
  check("그리고 실제로 요약이 일어난다", history.notice !== undefined, String(history.notice));
  globalThis.fetch = originalFetch;
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
