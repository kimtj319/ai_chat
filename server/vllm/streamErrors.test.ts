// 모델 서버가 200 스트림 안에 오류를 실어 보낼 때의 처리 검사.
// `npx tsx server/vllm/streamErrors.test.ts` 로 돈다.
//
//   1. 스트림 안의 오류는 빈 답으로 지나가지 않고 오류로 올라온다.
//   2. thinking_token_budget 을 못 받는 서버(vLLM 을 --reasoning-config 없이 띄움)는
//      상한 없이 한 번 다시 보내고, 그 엔드포인트·모델에는 다음부터 보내지 않는다.
//      스트림 안의 거절과 HTTP 400 거절 둘 다.
//   3. 다른 모델에는 여전히 보낸다.
process.env.VLLM_ENDPOINTS = "mock|http://mock-a/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";

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

const REFUSAL =
  "thinking_token_budget is set but reasoning_config is not configured. Please set --reasoning-config to use thinking_token_budget.";
const sent: Array<{ model: string; budget: boolean }> = [];
/** model → how it answers a request that carries thinking_token_budget. */
const refuses = new Map<string, "stream" | "http">([
  ["refuse-stream", "stream"],
  ["refuse-http", "http"],
]);

function sse(lines: unknown[]): Response {
  const text = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const budget = "thinking_token_budget" in body;
  sent.push({ model: body.model, budget });
  if (body.model === "broken") {
    return sse([{ error: { message: "something exploded", type: "InternalServerError", code: 500 } }]);
  }
  const how = refuses.get(body.model);
  if (budget && how === "stream") return sse([{ error: { message: REFUSAL, type: "BadRequestError", code: 400 } }]);
  if (budget && how === "http") {
    return new Response(JSON.stringify({ error: { message: REFUSAL, code: 400 } }), { status: 400 });
  }
  return sse([
    { choices: [{ delta: { content: "답" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ]);
}) as typeof fetch;

const { streamChatCompletion } = await import("./client.js");
const endpoint = { label: "mock", baseUrl: "http://mock-a/v1" };

async function ask(model: string, budget = true): Promise<string> {
  const stream = await streamChatCompletion(
    {
      model,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      ...(budget ? { thinking_token_budget: 512, chat_template_kwargs: { enable_thinking: true } } : {}),
    } as never,
    new AbortController().signal,
    endpoint as never,
  );
  let text = "";
  for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content ?? "";
  return text;
}

console.log("server/vllm/client.ts — 스트림 안의 오류");

{
  let error: unknown = null;
  try {
    await ask("broken", false);
  } catch (err) {
    error = err;
  }
  check("스트림 안의 오류는 오류로 올라온다", error instanceof Error && /something exploded/.test(error.message), String(error));
}

for (const model of ["refuse-stream", "refuse-http"]) {
  sent.length = 0;
  const first = await ask(model);
  check(`${model}: 상한 없이 다시 보내 답을 받는다`, first === "답", first);
  check(
    `${model}: 처음엔 상한을 실었고, 다시 보낼 땐 뺐다`,
    JSON.stringify(sent.map((s) => s.budget)) === "[true,false]",
    JSON.stringify(sent),
  );
  sent.length = 0;
  const second = await ask(model);
  check(`${model}: 다음부터는 처음부터 상한을 빼고 보낸다(한 번에 끝)`, second === "답" && JSON.stringify(sent.map((s) => s.budget)) === "[false]", JSON.stringify(sent));
}

{
  sent.length = 0;
  await ask("accepts-budget");
  check("다른 모델에는 상한을 그대로 보낸다", JSON.stringify(sent) === JSON.stringify([{ model: "accepts-budget", budget: true }]), JSON.stringify(sent));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
