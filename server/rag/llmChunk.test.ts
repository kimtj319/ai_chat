// LLM 경계 청킹 테스트. 프레임워크 없이 `npm test` 로 돌린다.
//
// 이 파일이 지키는 것은 하나다: **모델이 무엇을 답하든 원문은 그대로 남는다.**
// 모델은 제안을 할 뿐이고 자르는 것은 우리이므로, 헛소리를 해도 결과는 나빠질
// 수 있을 뿐 손상되지는 않아야 한다. 그래서 아래 절반은 일부러 잘못된 응답을
// 돌려주는 가짜 모델이다.
import http from "node:http";
import { once } from "node:events";

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const squeeze = (s: string) => s.replace(/\s+/g, "");

/* ------------------------------------------------------------- 가짜 모델 서버 */

/**
 * 시나리오마다 갈아 끼운다. 받은 줄 수를 주고, 응답 본문 문자열을 돌려준다.
 * `null` 을 돌려주면 연결을 끊는다 — 모델 서버가 죽은 경우를 같은 모듈,
 * 같은 설정으로 재현하려면 이쪽이 유일하게 정직한 방법이다(설정은 모듈이
 * 로드될 때 한 번 읽히므로, 주소를 바꿔치기하는 시늉은 아무것도 검증하지 못한다).
 */
let reply: (lineCount: number) => string | null = () => "[]";

const stub = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const user = body.messages.find((m: { role: string }) => m.role === "user").content as string;
  const answer = reply(user.split("\n").length);
  if (answer === null) {
    req.socket.destroy();
    return;
  }
  const payload = JSON.stringify({ choices: [{ message: { content: answer } }] });
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
});
stub.listen(0, "127.0.0.1");
await once(stub, "listening");
const port = (stub.address() as { port: number }).port;

// config 는 로드 시점에 읽히므로 import 보다 먼저 세운다 — 운영과 같은 순서다.
process.env.RAG_CHUNK_MODEL_URL = `http://127.0.0.1:${port}/v1`;
process.env.RAG_CHUNK_MODEL = "test/boundary-picker";

const { planChunks, _internals } = await import("./llmChunk.js");
const { chunkText } = await import("./chunk.js");

/* ------------------------------------------------------------------ 테스트 자료 */

const PARA = (n: number) =>
  `${n}번 문단이다. 색인 API 는 POST /index/{컬렉션} 이고 본문은 문서 객체의 배열이다. ` +
  `응답은 result 와 success, fail, total 을 담는다. 문서가 전부 실패해도 HTTP 200 이 ` +
  `돌아오므로 상태 코드만 보고 성공을 판단하면 안 되고 반드시 fail 목록을 확인해야 한다.`;
const DOC = Array.from({ length: 14 }, (_, i) => PARA(i + 1)).join("\n\n");

/* -------------------------------------------------------------------- 테스트 */

console.log("server/rag/llmChunk.ts");

async function preserved(name: string, replier: (n: number) => string) {
  reply = replier;
  const plan = await planChunks(DOC);
  const rebuilt = plan.chunks.map((c) => c.text.slice(c.overlapLen)).join("");
  check(name, squeeze(rebuilt) === squeeze(DOC), `원문 ${squeeze(DOC).length}자 → ${squeeze(rebuilt).length}자`);
  return plan;
}

{
  const plan = await preserved("정상 응답: 원문이 그대로 복원된다", (n) => `[${Math.floor(n / 3)}, ${Math.floor((n * 2) / 3)}]`);
  eq("모델이 경계를 골랐다고 보고한다", plan.method, "llm");
  check("청크가 둘 이상 나왔다", plan.chunks.length > 1, `${plan.chunks.length}개`);
}

// 아래는 전부 "모델이 잘못 답한" 경우다. 결과가 나빠질 수는 있어도 원문은 남아야 한다.
await preserved("빈 배열을 답해도 원문이 남는다", () => "[]");
await preserved("범위 밖 줄 번호를 답해도 원문이 남는다", () => "[-5, 0, 99999]");
await preserved("역순·중복을 답해도 원문이 남는다", (n) => `[${n - 1}, 3, 3, 3, 2]`);
await preserved("첫 줄(1)을 답해도 원문이 남는다", () => "[1, 1, 1]");
await preserved("모든 줄을 답해도 원문이 남는다", (n) => `[${Array.from({ length: n }, (_, i) => i + 1).join(",")}]`);
await preserved("JSON 이 아닌 말을 해도 원문이 남는다", () => "음, 잘 모르겠습니다.");
await preserved("코드펜스를 둘러도 원문이 남는다", (n) => "```json\n[" + Math.floor(n / 2) + "]\n```");
await preserved("소수·문자열이 섞여도 원문이 남는다", () => '[2.5, "네", 4, null]');

{
  reply = () => "[]";
  const plan = await planChunks(DOC);
  eq("모델이 하나도 못 고르면 규칙 기반으로 보고한다", plan.method, "rule");
  const rule = chunkText(DOC);
  eq("그때의 결과는 규칙 기반과 같다", plan.chunks.length, rule.length);
}

{
  reply = (n) => `[${Math.floor(n / 2)}]`;
  const plan = await planChunks(DOC);
  const tooLong = plan.chunks.filter((c) => c.text.length > 600 + 80);
  eq("모델이 넓게 잡아도 청크 길이 상한은 지켜진다", tooLong.length, 0);
}

{
  // 모델이 한 줄씩 끊자고 해도 20자짜리 청크를 내놓아서는 안 된다.
  reply = (n) => `[${Array.from({ length: n }, (_, i) => i + 1).join(",")}]`;
  const plan = await planChunks(DOC);
  const tiny = plan.chunks.filter((c) => c.text.slice(c.overlapLen).length < 40);
  eq("잘게 끊자는 답에도 지나치게 짧은 청크가 남지 않는다", tiny.length, 0);
}

{
  // 모델 서버가 연결을 끊는 경우. 던지지 않고 규칙 기반으로 넘어가야 한다.
  reply = () => null;
  const plan = await planChunks(DOC);
  const rebuilt = plan.chunks.map((c) => c.text.slice(c.overlapLen)).join("");
  check("모델 서버가 끊어도 색인은 진행된다", plan.chunks.length > 0 && squeeze(rebuilt) === squeeze(DOC), `${plan.chunks.length}청크`);
  eq("그리고 규칙 기반이라고 보고한다", plan.method, "rule");
  const rule = chunkText(DOC);
  eq("결과도 규칙 기반과 같다", plan.chunks.length, rule.length);
}

{
  // 창 나누기는 문단 경계(빈 줄)에서만 일어나야 한다.
  const long = Array.from({ length: 40 }, (_, i) => PARA(i + 1)).join("\n\n");
  const windows: string[] = _internals.splitWindows(long);
  check("긴 문서는 여러 창으로 나뉜다", windows.length > 1, `${windows.length}창`);
  check("창을 이어 붙이면 원문이다", squeeze(windows.join("\n")) === squeeze(long), "");
  check("어떤 창도 문장 중간에서 시작하지 않는다", windows.every((w) => /^\s*\d+번 문단이다/.test(w)), "");
}

/* ---------------------------------------------------------------------- 결과 */

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
stub.close();
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
