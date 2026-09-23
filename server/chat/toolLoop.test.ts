// runConversationTurn() 의 "컨텍스트가 차면 압축 후 계속 진행한다" 계약 검사.
// `npx tsx server/chat/toolLoop.test.ts` 로 돈다.
//
// 실제 vLLM 없이 global.fetch 를 가짜로 바꿔서 돈다: /models, /tokenize,
// /chat/completions 세 경로만 흉내 낸다. 토큰 수는 진짜 토크나이저가 아니라
// 이 파일이 정한 결정적 공식(JSON 문자열 길이/4)으로 세므로, 절대적인 토큰
// 숫자가 아니라 "그 공식 기준으로" 비율을 넘기고 못 넘기게 대화를 구성한다.
//
// 이 검사가 지키는 계약(과제 1):
//   A. 대화 "이력"이 쌓여 컨텍스트 한도(CONTEXT_TOOL_STOP_RATIO)에 가까워지면
//      — 이번 턴이 아직 도구를 하나도 안 썼어도 — historySummary 가 먼저
//      실행돼 자리를 만들고, 이번 턴은 도구가 막히지 않은 채로 진행된다.
//      (수정 전에는 이 지점에서 요약이 실행되지 않아 1라운드부터 도구가
//      막혔다 — server/chat/historySummary.ts 의 needsSummary 참고.)
//   B. 압축(요약)으로 만들 자리가 전혀 없을 때만(=couldSummarise 가 거짓인
//      새 대화에서 첫 메시지 자체가 이미 큰 경우) 도구 중단이 "최후 수단"으로
//      실제 발동하고, 턴은 멈추지 않고 끝까지 끝난다.
//   C. 한 턴 안에서 모델이 계속 새로운 인자로 도구를 불러 컨텍스트가 계속
//      자라도, contextMaxCompactions 만큼만 압축하고 그 뒤로는 도구를
//      중단해 턴이 유한한 라운드 안에 끝난다(무한 루프 없음).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* --------------------------------------------------------- 환경 설정 (import 전) */
// config.ts 는 모듈을 불러오는 시점에 process.env 를 읽으므로, 아래 값들은
// 어떤 server/* 모듈보다도 먼저 정해져야 한다.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-toolloop-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0"; // 가짜 서버에 확률적 프로브까지 흉내 낼 필요는 없다.
process.env.CONTEXT_TOOL_STOP_RATIO = "0.8";
process.env.CONTEXT_COMPACT_RATIO = "0.5";
process.env.CONTEXT_KEEP_RECENT_RATIO = "0.1";
process.env.CONTEXT_MAX_COMPACTIONS = "2";
process.env.REASONING_PROFILES = "";

const { runConversationTurn } = await import("./toolLoop.js");
const { invalidateCatalog } = await import("../vllm/client.js");
const { DEFAULT_SETTINGS } = await import("../types.js");
const { DEFAULT_SYSTEM_PROMPT } = await import("./systemPrompt.js");
const { config } = await import("../config.js");
type Conversation = import("../types.js").Conversation;
type StoredMessage = import("../types.js").StoredMessage;

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

console.log("server/chat/toolLoop.ts — 컨텍스트가 차면 압축 후 계속 진행한다");

/* ---------------------------------------------------------------- 가짜 vLLM */

/** /tokenize 가 셀 방식. countPromptTokens() 의 실제 계산과 무관하게, 이
 * 테스트 안에서 "요청이 이만큼 크다"를 결정적으로 재는 유일한 잣대다. */
function estimateTokens(body: { messages?: unknown[]; tools?: unknown[] }): number {
  const len = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length;
  return Math.ceil(len / 4);
}

/** 등록된 모델과 그 컨텍스트 창. GET /models 가 이 맵 전체를 돌려준다. */
const registeredModels = new Map<string, number>();

interface ChatCall {
  body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; tool_choice?: string };
}

/** 시나리오마다 "메인 라운드" 요청에 무엇을 답할지 정하는 훅. */
type MainRoundHandler = (call: ChatCall, roundIndex: number) => { content?: string; toolCall?: { name: string; arguments: unknown } };

let mainRoundHandler: MainRoundHandler = () => ({ content: "ok" });
/**
 * 시나리오 D("지금 답변하기") 전용 훅. 있으면 다음 메인 라운드 요청은
 * mainRoundHandler 대신 이 요청을 영원히 붙들었다가, 신호가 끊길 때만
 * 거절한다 — 한 번 쓰고 스스로 null 로 되돌아간다.
 */
let hangNextMainRound: (() => void) | null = null;
let mainRoundCalls = 0;
let historySummaryCalls = 0;
let compactionSummaryCalls = 0;

function resetCallCounters(): void {
  mainRoundCalls = 0;
  historySummaryCalls = 0;
  compactionSummaryCalls = 0;
}

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

function lastContent(body: ChatCall["body"]): string {
  const last = body.messages[body.messages.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET" && url.endsWith("/models")) {
    const data = [...registeredModels].map(([id, max_model_len]) => ({ id, max_model_len }));
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const raw = typeof init?.body === "string" ? init.body : "{}";
  const body = JSON.parse(raw);

  if (method === "POST" && url.endsWith("/tokenize")) {
    const maxModelLen = registeredModels.get(body.model) ?? null;
    return new Response(
      JSON.stringify({ count: estimateTokens(body), max_model_len: maxModelLen }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (method === "POST" && url.endsWith("/chat/completions")) {
    if (body.stream === false) {
      // 능력 프로브(껐지만 방어적으로 응답은 준비해 둔다).
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const content = lastContent(body);
    if (content.includes("이전 대화 요약")) {
      historySummaryCalls++;
      return sseResponse([
        {
          choices: [
            {
              delta: {
                content:
                  "1. 대화 주제: 테스트용 긴 대화.\n2. 확인된 사실과 결정: 없음.\n3. 사용자의 요청과 답변: 없음.\n4. 진행 중인 일과 남은 것: 없음.",
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
      ]);
    }
    if (content.includes("중간 조사 보고")) {
      compactionSummaryCalls++;
      return sseResponse([
        {
          choices: [
            {
              delta: {
                content:
                  "1. 원래 질문: 테스트 질문\n2. 확인된 사실: 없음\n3. 이미 확인한 것: 테스트 도구 호출\n4. 아직 확인이 필요한 것: 없음",
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
      ]);
    }
    // 메인 라운드.
    const roundIndex = mainRoundCalls++;
    // 시나리오 D 전용: "지금 답변하기" 는 실제로 vLLM 에 나가 있는(아직 응답이
    // 안 온) 요청을 끊는 상황이라, 이 요청을 절대 스스로 끝내지 않고 신호가
    // 끊길 때만 거절한다. hook() 은 abort 리스너를 건 *다음* 에 불러서,
    // 테스트가 이 시점에 답변하기를 눌러도 반드시 잡히게 한다.
    if (hangNextMainRound) {
      const hook = hangNextMainRound;
      hangNextMainRound = null;
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
    const answer = mainRoundHandler({ body }, roundIndex);
    if (answer.toolCall) {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${roundIndex}`,
                    type: "function",
                    function: { name: answer.toolCall.name, arguments: JSON.stringify(answer.toolCall.arguments) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: answer.content ?? "" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
    ]);
  }

  throw new Error(`이 테스트가 예상하지 못한 요청: ${method} ${url}`);
}) as typeof fetch;

/* ------------------------------------------------------------------ 도우미 */

function vllmShape(messages: StoredMessage[]): unknown[] {
  return [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
}

/** 목표 토큰 수(이 파일의 estimateTokens 기준) 근처가 되도록 채움 문자열 길이를 구한다. */
function fillerCharsFor(messages: StoredMessage[], targetTokens: number): number {
  const baseLen = JSON.stringify(vllmShape(messages)).length;
  const targetChars = targetTokens * 4;
  return Math.max(0, targetChars - baseLen);
}

function makeConversation(overrides: Partial<Conversation>): Conversation {
  const now = new Date().toISOString();
  return {
    id: `conv-${Math.random().toString(36).slice(2)}`,
    title: "test",
    systemPrompt: "",
    model: "",
    settings: { ...DEFAULT_SETTINGS },
    enabledTools: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Conversation;
}

async function runTurn(conversation: Conversation, answerNowSignal?: AbortSignal) {
  invalidateCatalog();
  const controller = new AbortController();
  // 시나리오 A/B/C 는 "지금 답변하기" 를 안 눌러서, 절대 끊기지 않는 신호를
  // 기본값으로 준다.
  const gen = runConversationTurn(conversation, "owner-1", controller.signal, answerNowSignal ?? new AbortController().signal);
  const events: Array<{ type: string; message?: string; [k: string]: unknown }> = [];
  let result: Awaited<ReturnType<typeof gen.next>>["value"];
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value as (typeof events)[number]);
  }
  const notices = events.filter((e) => e.type === "notice").map((e) => String(e.message));
  return { events, result: result!, notices };
}

/* ============================================================== 시나리오 A */
// "압축 후 계속": 대화 이력만으로 이미 CONTEXT_TOOL_STOP_RATIO 를 넘지만
// (needsSummary 의 하드 플로어에는 한참 못 미치는 지점), 이번 턴은 도구를
// 하나도 아직 안 썼다. 예전 코드라면 1라운드부터 도구가 막혔을 지점이다.
{
  resetCallCounters();
  const WINDOW = 20_000;
  registeredModels.set("model-a", WINDOW);

  // couldSummarise 를 만족하려면(KEEP_RECENT_MESSAGES=4, MIN_NEW_MESSAGES=2)
  // 최소 6개 이상 필요 — 10개로 여유를 둔다. index 0 을 채워서 크기를 만든다.
  const messages: StoredMessage[] = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `메시지 ${i}`,
    createdAt: new Date().toISOString(),
  }));
  // maxTokens 를 낮춰 하드 플로어(window - maxTokens - SAFETY_MARGIN)를
  // 비율 지점(0.8 x window)보다 훨씬 뒤로 밀어낸다 — 그 사이 구간에 목표를 둔다.
  const settings = { ...DEFAULT_SETTINGS, maxTokens: 100 };
  const ratioTokens = Math.floor(WINDOW * config.contextToolStopRatio);
  const targetTokens = ratioTokens + 200; // 비율은 넘고
  const hardFloorTokens = WINDOW - settings.maxTokens - 2048; // contextBudget.SAFETY_MARGIN_TOKENS
  const fillerChars = fillerCharsFor(messages, targetTokens);
  messages[0]!.content = "x".repeat(fillerChars);

  check(
    "시나리오 A 준비: 목표가 비율은 넘고 하드 플로어에는 못 미친다",
    targetTokens > ratioTokens && targetTokens < hardFloorTokens,
    `ratio=${ratioTokens} target=${targetTokens} hardFloor=${hardFloorTokens}`,
  );

  mainRoundHandler = (call) => {
    check("시나리오 A: 메인 라운드는 도구가 막히지 않은 채로 나간다", call.body.tool_choice === "auto", JSON.stringify(call.body.tool_choice));
    return { content: "요약 후 정상 답변입니다." };
  };

  const conversation = makeConversation({ model: "model-a", enabledTools: ["calculator"], messages, settings });
  const { result, notices } = await runTurn(conversation);

  check("시나리오 A: 이전 대화 요약이 실제로 실행됐다", historySummaryCalls === 1, String(historySummaryCalls));
  check(
    "시나리오 A: 도구 중단 알림이 없다",
    !notices.some((n) => n.includes("도구 호출을 중단")),
    JSON.stringify(notices),
  );
  check("시나리오 A: 메인 라운드는 1회만 돌았다(정상 종료)", mainRoundCalls === 1, String(mainRoundCalls));
  check("시나리오 A: 최종 답변이 그대로 왔다", result.content === "요약 후 정상 답변입니다.");
  check(
    "시나리오 A: 대화 객체에 요약이 저장됐다(다음 턴부터 이력이 작아진다)",
    Boolean((conversation as unknown as { historySummary?: unknown }).historySummary),
  );
}

/* ============================================================== 시나리오 B */
// "압축할 여지가 전혀 없을 때만 중단": 새 대화라 couldSummarise 가 거짓이고
// (접을 이전 턴이 없다), 첫 메시지 자체가 이미 창을 넘긴다. 이때는 압축이
// 아무것도 못 하므로 도구 중단이 최후 수단으로 실제 발동해야 하고, 턴은
// 멈추지 않고 끝까지 끝나야 한다.
{
  resetCallCounters();
  const WINDOW = 5_000;
  registeredModels.set("model-b", WINDOW);

  const messages: StoredMessage[] = [{ id: "u1", role: "user", content: "", createdAt: new Date().toISOString() }];
  const ratioTokens = Math.floor(WINDOW * config.contextToolStopRatio);
  const fillerChars = fillerCharsFor(messages, ratioTokens + 2000); // 비율을 넉넉히 넘긴다
  messages[0]!.content = "x".repeat(fillerChars);

  mainRoundHandler = (call) => {
    check(
      "시나리오 B: 압축할 게 없으니 도구가 실제로 막혀서 나간다",
      call.body.tool_choice === "none",
      JSON.stringify(call.body.tool_choice),
    );
    return { content: "압축 없이 도구 없이 답변." };
  };

  const conversation = makeConversation({ model: "model-b", enabledTools: ["calculator"], messages });
  const { result, notices } = await runTurn(conversation);

  check("시나리오 B: 요약도 압축도 실행되지 않았다(할 게 없어서)", historySummaryCalls === 0 && compactionSummaryCalls === 0);
  check(
    "시나리오 B: 도구 중단이 최후 수단으로 실제 발동했다",
    notices.some((n) => n.includes("도구 호출을 중단")),
    JSON.stringify(notices),
  );
  check("시나리오 B: 그래도 턴은 끝까지 끝난다(멈추지 않는다)", result.content === "압축 없이 도구 없이 답변.");
  check("시나리오 B: 메인 라운드는 1회만 돌았다", mainRoundCalls === 1, String(mainRoundCalls));
}

/* ============================================================== 시나리오 C */
// "무한 반복 없음": 모델이 매 라운드 새 인자로 도구를 계속 부른다(반복 호출
// 가드에는 안 걸리게). 컨텍스트는 라운드마다 커지므로, contextMaxCompactions
// 만큼 압축된 뒤에는 도구가 중단되고 턴이 유한한 라운드 안에 끝나야 한다.
{
  resetCallCounters();
  const WINDOW = 50_000;
  registeredModels.set("model-c", WINDOW);
  const ARG_CHARS = 20_000; // 라운드마다 이만큼 컨텍스트가 자란다.

  mainRoundHandler = (call, roundIndex) => {
    if (call.body.tool_choice === "auto") {
      // 매번 다른 인자 — MAX_IDENTICAL_TOOL_CALLS(=3) 가드에 걸리지 않게 한다.
      return { toolCall: { name: "calculator", arguments: { expression: `${roundIndex}+${"1".repeat(ARG_CHARS)}` } } };
    }
    return { content: "도구 중단 후 최종 답변." };
  };

  const conversation = makeConversation({ model: "model-c", enabledTools: ["calculator"] });
  const { result, notices } = await runTurn(conversation);

  check(
    "시나리오 C: 압축이 설정된 상한(CONTEXT_MAX_COMPACTIONS)만큼만 일어났다",
    compactionSummaryCalls === config.contextMaxCompactions,
    `compactionSummaryCalls=${compactionSummaryCalls}, contextMaxCompactions=${config.contextMaxCompactions}`,
  );
  check(
    "시나리오 C: 압축이 소진된 뒤에는 컨텍스트 한도로 도구가 중단됐다",
    notices.some((n) => n.includes("도구 호출을 중단")),
    JSON.stringify(notices),
  );
  check(
    "시나리오 C: '같은 도구 반복' 가드가 아니라 컨텍스트 가드로 멈췄다(인자를 매번 바꿨으므로)",
    !notices.some((n) => n.includes("같은 도구를 같은 인자로")),
    JSON.stringify(notices),
  );
  check(
    "시나리오 C: 도구 호출 총 40회(MAX_TOOL_CALLS_PER_TURN) 상한이 아니라 컨텍스트로 먼저 멈췄다",
    mainRoundCalls < 40,
    String(mainRoundCalls),
  );
  check("시나리오 C: 그래도 턴은 유한한 라운드 안에 끝나고 답을 낸다", result.content === "도구 중단 후 최종 답변.");
}

/* ============================================================== 시나리오 D */
// "지금 답변하기": answerNowSignal 이 오면, 실제로 vLLM 에 나가 있던(아직
// 응답이 안 온) 모델 호출을 즉시 끊고, "취소됨" 이 아니라 도구 없는 마무리
// 답변으로 넘어가야 한다 — 그리고 이 동작은 reasoningMode 와 무관해야 한다
// (여기서는 conversation 이 기본값인 "external" 이다).
{
  resetCallCounters();
  const WINDOW = 50_000;
  registeredModels.set("model-d", WINDOW);

  const answerNowController = new AbortController();
  // 첫 메인 라운드 요청이 실제로 나간(그리고 아직 답이 안 온) 바로 그 순간에
  // 누른다 — 그래야 "진행 중이던 호출을 끊는다" 는 실제 상황이 된다.
  hangNextMainRound = () => answerNowController.abort();

  mainRoundHandler = (call) => {
    const content = lastContent(call.body);
    check(
      "시나리오 D: 마무리 호출은 도구 없이 나간다(tool_choice 자체가 없다)",
      call.body.tool_choice === undefined,
      JSON.stringify(call.body.tool_choice),
    );
    check(
      "시나리오 D: 마무리 호출에 '지금 답변하기' 사유가 담긴다",
      content.includes("지금 답변하기"),
      content.slice(0, 200),
    );
    return { content: "지금까지의 조사로 정리한 답변입니다." };
  };

  const conversation = makeConversation({ model: "model-d", enabledTools: ["calculator"] });
  const { result, notices } = await runTurn(conversation, answerNowController.signal);

  check(
    "시나리오 D: '취소됨' 이 아니라 정상 답변으로 끝난다",
    !result.error,
    JSON.stringify(result.error),
  );
  check(
    "시나리오 D: 최종 답변이 마무리 호출의 내용이다",
    result.content === "지금까지의 조사로 정리한 답변입니다.",
    result.content,
  );
  check("시나리오 D: 도구는 하나도 실행되지 않았다", result.toolCalls.length === 0, String(result.toolCalls.length));
  check(
    "시나리오 D: 안내 알림에 '지금 답변하기' 사유가 남는다",
    notices.some((n) => n.includes("지금 답변하기")),
    JSON.stringify(notices),
  );
  check(
    "시나리오 D: 메인 라운드는 (끊긴 1회 + 마무리 1회) 두 번 시도됐다",
    mainRoundCalls === 2,
    String(mainRoundCalls),
  );
}

/* ============================================================== 시나리오 E */
// "지금 답변하기" 를 도구 결과를 모은 **뒤에** 누르는 경우. 마무리 답변은 그
// 결과를 받아야 한다 — 사용자는 "그 시점까지 모은 정보로 답하라" 고 했다.
// 예전에는 도구 루프 시작 전의 이력을 넘겨서, 운영 서버 실측에서 도구를 다섯 번 부른
// 뒤 누르자 "요청하신 도구 호출을 아직 수행하지 않았습니다" 라고 답했다.
// 시나리오 D 는 첫 라운드에서 누르므로 이 결함을 잡지 못했다.
{
  resetCallCounters();
  registeredModels.set("model-e", 50_000);
  const answerNowController = new AbortController();
  let wrapUpMessages: Array<{ role: string; content?: unknown }> | null = null;

  mainRoundHandler = (call, roundIndex) => {
    if (roundIndex === 0) {
      // 첫 라운드는 도구를 부른다. 다음 메인 라운드가 나가는 순간 누르게 걸어 둔다.
      hangNextMainRound = () => answerNowController.abort();
      return { toolCall: { name: "calculator", arguments: { expression: "2026^2" } } };
    }
    wrapUpMessages = call.body.messages as Array<{ role: string; content?: unknown }>;
    return { content: "모은 결과로 정리한 답변입니다." };
  };

  const conversation = makeConversation({ model: "model-e", enabledTools: ["calculator"] });
  const { result } = await runTurn(conversation, answerNowController.signal);

  check("시나리오 E: 정상 답변으로 끝난다", !result.error, JSON.stringify(result.error));
  check("시나리오 E: 도구는 한 번 실행됐다", result.toolCalls.length === 1, String(result.toolCalls.length));
  const toolMessages = (wrapUpMessages ?? []).filter((m) => m.role === "tool");
  // 이 두 줄이 시나리오의 존재 이유다.
  check("시나리오 E: 마무리 호출에 이번 턴의 도구 결과가 실려 간다", toolMessages.length === 1, JSON.stringify(wrapUpMessages?.map((m) => m.role)));
  check(
    "시나리오 E: 그 결과는 계산기가 실제로 돌려준 값이다",
    toolMessages.some((m) => String(m.content).includes("4104676")),
    JSON.stringify(toolMessages),
  );
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
