// consolidateProhibitions() 의 모델 선택 검사. `npx tsx server/chat/prohibitionDetect.test.ts` 로 돈다.
//
// 보려는 것: 정리안을 만드는 호출도 vllm/access.ts 의 규칙을 지난다. 그 계정이 쓸 수
// 없는 엔드포인트(다른 사람이 등록한 것 등)가 카탈로그 맨 앞에 있어도, 허용된
// 엔드포인트의 모델이 답한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-prohibition-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "first|http://mock-first/v1,second|http://mock-second/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_ENDPOINTS_FILE = "";
process.env.MODEL_CAPABILITY_PROBE = "0";

const { consolidateProhibitions } = await import("./prohibitionDetect.js");

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

console.log("server/chat/prohibitionDetect.ts — consolidateProhibitions 의 모델 선택");

const chatHosts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.pathname === "/v1/models") {
    return new Response(JSON.stringify({ data: [{ id: `${url.host}-model`, max_model_len: 8192 }] }), { status: 200 });
  }
  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    chatHosts.push(url.host);
    const chunk = { choices: [{ delta: { content: "- 영어로 답하지 않는다." }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
  }
  throw new Error(`unexpected request ${method} ${url}`);
}) as typeof fetch;

{
  const allows = (entry: { baseUrl: string }) => entry.baseUrl === "http://mock-second/v1";
  const proposal = await consolidateProhibitions(
    ["영어로 답하지 않는다.", "영어 단어를 섞어 답하지 않는다."],
    new AbortController().signal,
    allows,
  );
  check("허용된 엔드포인트의 모델이 정리안을 만든다", JSON.stringify(chatHosts) === '["mock-second"]', JSON.stringify(chatHosts));
  check("  정리안은 그대로 돌아온다", proposal === "- 영어로 답하지 않는다.", String(proposal));
}

{
  chatHosts.length = 0;
  await consolidateProhibitions(["가를 하지 않는다.", "나를 하지 않는다."], new AbortController().signal);
  check("allows 를 주지 않으면 예전처럼 카탈로그 첫 모델을 쓴다", JSON.stringify(chatHosts) === '["mock-first"]', JSON.stringify(chatHosts));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
