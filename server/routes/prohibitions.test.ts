// 사용자별 "하지 말 것" 목록 검사. `npm test` 로 돈다.
//
// 확인하려는 것:
//   1. 검토 대기에 있는 것은 반영되지 않는다. 자동 감지의 오탐이 조용히 모든
//      대화를 바꾸지 않게 하는 유일한 장치라, 이 경계가 틀리면 설계 전체가 무너진다.
//   2. 같은 말은 두 번 쌓이지 않는다.
//   3. 목록은 자기 것만 보인다(경로에 계정 id 가 없다).
//   4. 모델의 답을 받아들이는 쪽이 모양이 어긋난 답을 거른다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "prohibitions-test-"));
process.env.DATA_DIR = dataDir;

const { prohibitionsRouter } = await import("./prohibitions.js");
const store = await import("../storage/prohibitionsStore.js");
const { parseDetection, parseConsolidation, NEGATIVE_CUE } = await import("../chat/prohibitionDetect.js");
const { composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } = await import("../chat/systemPrompt.js");

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

console.log("server/storage/prohibitionsStore.ts + chat/prohibitionDetect.ts + routes/prohibitions.ts");

/* ------------------------------------------------------ 반영 / 검토 대기 경계 */

{
  check("빈 틀은 아무것도 반영하지 않는다", store.activeText(store.TEMPLATE) === "", JSON.stringify(store.activeText(store.TEMPLATE)));

  const md = `# 하지 말아야 할 것\n<!-- 설명 -->\n- 영어로 답하지 않는다\n\n## 검토 대기\n- 표를 쓰지 않는다 <!-- 2026-09-23 · "표 필요 없어" -->\n`;
  const active = store.activeText(md);
  check("반영 부분에 위쪽 항목이 들어간다", active.includes("영어로 답하지 않는다"), active);
  check("검토 대기 항목은 반영되지 않는다", !active.includes("표를"), active);
  check("주석과 제목은 걷힌다", !active.includes("설명") && !active.includes("#"), active);
  check("검토 대기 개수", store.pendingCount(md) === 1, String(store.pendingCount(md)));

  const noHeading = "- 하나\n- 둘";
  check("경계가 없으면 전부 반영된다", store.activeText(noHeading) === noHeading);

  const long = Array.from({ length: 400 }, (_, i) => `- 규칙 번호 ${i}`).join("\n");
  const capped = store.capActive(long);
  check("상한에서 자른다", capped.truncated && capped.text.length <= store.PROHIBITIONS_LIMIT_CHARS);
  check("줄 중간에서 자르지 않는다", capped.text.split("\n").every((l) => /^- 규칙 번호 \d+$/.test(l)));
}

/* ---------------------------------------------------------- 검토 대기에 보태기 */

{
  const owner = "alice";
  const at = new Date("2026-09-23T00:00:00Z");
  check("처음 보탠다", (await store.appendPending(owner, "표를 쓰지 않는다", "표는 필요 없어요", at)) === true);
  check("문장부호·띄어쓰기만 다르면 같은 규칙", (await store.appendPending(owner, "표를  쓰지 않는다.", "또 표네", at)) === false);
  let md = await store.readProhibitions(owner);
  check("틀 위에 쌓인다", md.startsWith("# 하지 말아야 할 것") && store.pendingCount(md) === 1, md);
  check("근거가 주석으로 붙는다", md.includes('"표는 필요 없어요"') && md.includes("2026-09-23"), md);

  // 사용자가 위로 옮긴 뒤에도 같은 말은 다시 쌓이지 않는다.
  await store.writeProhibitions(owner, `- 표를 쓰지 않는다\n\n${store.PENDING_HEADING}\n`);
  check("반영된 규칙과 같으면 보태지 않는다", (await store.appendPending(owner, "표를 쓰지 않는다", "x", at)) === false);

  check("주석을 닫는 문자열이 근거에 있어도 주석이 깨지지 않는다", await store.appendPending(owner, "과장하지 않는다", "그만 --> 해", at));
  md = await store.readProhibitions(owner);
  check("…그리고 반영 부분이 오염되지 않는다", store.activeText(md) === "- 표를 쓰지 않는다", store.activeText(md));

  check("너무 짧은 규칙은 버린다", (await store.appendPending(owner, "안", "x", at)) === false);

  let tooLarge = false;
  try {
    await store.writeProhibitions(owner, "x".repeat(store.PROHIBITIONS_FILE_MAX_CHARS + 1));
  } catch (err) {
    tooLarge = err instanceof store.ProhibitionsTooLargeError;
  }
  check("파일 상한을 넘는 저장은 거절한다", tooLarge);

  const saved = await store.writeProhibitions(owner, "- 하나\r\n- 둘\u0007");
  check("줄바꿈을 모으고 제어문자를 걷는다", saved === "- 하나\n- 둘", JSON.stringify(saved));
}

/* ------------------------------------------------------------ 모델 답 파싱 */

{
  check("해당", parseDetection('{"negative": true, "rule": "영어로 답하지 않는다"}') === "영어로 답하지 않는다");
  check("해당 아님", parseDetection('{"negative": false}') === null);
  check("코드 펜스를 견딘다", parseDetection('```json\n{"negative": true, "rule": "표를 쓰지 않는다"}\n```') === "표를 쓰지 않는다");
  check("<think> 를 견딘다", parseDetection('<think>{"x":1}</think>{"negative": true, "rule": "길게 쓰지 않는다"}') === "길게 쓰지 않는다");
  check("JSON 이 아니면 null", parseDetection("잘 모르겠습니다") === null);
  check("너무 긴 규칙은 null", parseDetection(JSON.stringify({ negative: true, rule: "가".repeat(store.RULE_MAX_CHARS + 1) })) === null);
  check("negative 가 문자열이면 null", parseDetection('{"negative": "true", "rule": "x 하지 않는다"}') === null);

  const original = "- 영어로 답하지 않는다\n- 영문으로 답변하지 않는다\n- 표를 쓰지 않는다";
  check("정리안은 목록 줄만 남긴다", parseConsolidation("정리했습니다:\n- 영어로 답하지 않는다\n* 표를 쓰지 않는다", original.length) === "- 영어로 답하지 않는다\n- 표를 쓰지 않는다");
  check("원래보다 길어진 정리안은 버린다", parseConsolidation(`${original}\n- 하나 더 지어낸 규칙`, original.length) === null);
  check("목록이 없는 정리안은 버린다", parseConsolidation("정리할 것이 없습니다", original.length) === null);

  check("단서 체: 불만은 통과", NEGATIVE_CUE.test("또 영어로 답했네요") && NEGATIVE_CUE.test("표로 만들 필요 없어요") && NEGATIVE_CUE.test("이모지 쓰지 마"));
  check("단서 체: 평범한 새 질문은 거른다", !NEGATIVE_CUE.test("파이썬으로 피보나치 구현해 줘") && !NEGATIVE_CUE.test("서울 날씨 알려 줘"));
}

/* ---------------------------------------------------------- 시스템 프롬프트 */

{
  check("목록이 없으면 기본 프롬프트 그대로", composeSystemPrompt(undefined, "") === DEFAULT_SYSTEM_PROMPT.trim());
  const both = composeSystemPrompt("반말로 답해", "- 영어로 답하지 않는다") ?? "";
  const rulesAt = both.indexOf("Things this user has asked you not to do");
  const extraAt = both.indexOf("Additional instructions for this conversation");
  check("금지 목록이 들어간다", rulesAt > 0 && both.includes("- 영어로 답하지 않는다"));
  check("대화별 지시가 금지 목록 뒤에 온다(뒤가 이긴다)", rulesAt < extraAt, `${rulesAt} ${extraAt}`);
}

/* ------------------------------------------------------------------- 라우트 */

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "bob");
  req.ownerId = who;
  req.user = { id: who, role: who === "admin" ? "admin" : "user" } as never;
  next();
});
app.use("/api", prohibitionsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

async function call(as: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { "x-as": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

{
  const first = await call("bob", "GET", "/prohibitions");
  check("처음 열면 빈 틀", first.status === 200 && first.json.markdown === store.TEMPLATE && first.json.activeChars === 0);
  const put = await call("bob", "PUT", "/prohibitions", { markdown: `- 이모지를 쓰지 않는다\n\n${store.PENDING_HEADING}\n- 후보 하나\n` });
  check("저장하면 집계가 돌아온다", put.status === 200 && put.json.activeChars > 0 && put.json.pendingCount === 1, JSON.stringify(put.json));
  const other = await call("carol", "GET", "/prohibitions");
  check("남의 목록은 보이지 않는다", other.status === 200 && !other.json.markdown.includes("이모지"));
  const admin = await call("admin", "GET", "/prohibitions");
  check("관리자도 자기 목록만 본다", !admin.json.markdown.includes("이모지"));
  const bad = await call("bob", "PUT", "/prohibitions", { markdown: 3 });
  check("문자열이 아니면 400", bad.status === 400);
  const big = await call("bob", "PUT", "/prohibitions", { markdown: "x".repeat(store.PROHIBITIONS_FILE_MAX_CHARS + 1) });
  check("너무 크면 413", big.status === 413);
  const few = await call("bob", "POST", "/prohibitions/consolidate");
  check("항목이 하나면 정리하지 않는다(409)", few.status === 409);
}

server.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
