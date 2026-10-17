// 예약 작업 검사. `npm test` 로 돈다.
//
// 확인하려는 것:
//   1. 시각 해석: "11:00" 은 오늘(지났으면 내일) 한국 시각, 날짜 붙은 시각도 한국 시각,
//      지난 시각·너무 먼 시각은 거절.
//   2. 도구: 크롬 제어가 켜진 턴의 예약은 크롬 작업이 되고, 목록·취소가 된다.
//   3. 실행: 크롬이 필요 없는 예약은 서버가 그 시각에 실행해 답을 대화에 남긴다.
//      크롬 예약은 아무도 맡지 않으면 GRACE 뒤에 "놓침" 이 되고 대화에 알린다.
//   4. 맡기(claim): 한 번만 성공하고, 너무 이르면 실패한다. 끝을 알리면 상태가 바뀐다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-web-schedule-test-"));
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
process.env.DATA_DIR = dataDir;
process.env.VLLM_ENDPOINTS = "mock|http://mock-vllm/v1";
process.env.VLLM_API_KEY = "";
process.env.MODEL_CAPABILITY_PROBE = "0";
process.env.REASONING_PROFILES = "";

const { parseRunAt, formatKst } = await import("./scheduleTime.js");
const { scheduleTaskTool, listScheduledTasksTool, cancelScheduledTaskTool } = await import("../tools/schedule.js");
const { runDueSchedules, GRACE_MS } = await import("./scheduleRunner.js");
const { listSchedules, createSchedule } = await import("../storage/scheduleStore.js");
const { createConversation, getConversation } = await import("../storage/conversationStore.js");
const { schedulesRouter } = await import("../routes/schedules.js");

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

console.log("server/chat/scheduleTime.ts + scheduleRunner.ts + tools/schedule.ts + routes/schedules.ts");

/* ---------------------------------------------------------------- 가짜 vLLM */

const REASONING_ONLY_MARKER = "추론만 남기는 예약";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("http://mock-vllm")) return realFetch(input, init);
  if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-model", max_model_len: 100000 }] }));
  if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ count: 50, max_model_len: 100000 }));
  // 본문 없이 추론만 내는 모델(wise-lloa-max 가 그랬다). 마무리 호출에도 본문이 없어,
  // 턴은 추론을 답으로 올린다(contentPromotedFromReasoning).
  if (typeof init?.body === "string" && init.body.includes(REASONING_ONLY_MARKER)) {
    const only = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "날씨를 생각해 보면 맑다." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(only, { headers: { "content-type": "text/event-stream" } });
  }
  const text =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "예약 답변입니다" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

/* ---------------------------------------------------------------- 1. 시각 해석 */

{
  // 2026-10-16 10:00 KST = 01:00Z
  const now = new Date("2026-10-16T01:00:00Z");
  check("\"11:00\" 은 오늘 11시(한국)", parseRunAt("11:00", now).toISOString() === "2026-10-16T02:00:00.000Z", parseRunAt("11:00", now).toISOString());
  check("이미 지난 \"09:30\" 은 내일", parseRunAt("09:30", now).toISOString() === "2026-10-17T00:30:00.000Z");
  check("날짜 붙은 시각은 한국 시각", parseRunAt("2026-10-20 23:15", now).toISOString() === "2026-10-20T14:15:00.000Z");
  check("오프셋 붙은 ISO 는 그대로", parseRunAt("2026-10-16T03:00:00Z", now).toISOString() === "2026-10-16T03:00:00.000Z");
  check("\"+30m\" 은 지금부터 30분 뒤", parseRunAt("+30m", now).toISOString() === "2026-10-16T01:30:00.000Z");
  check("\"+2h\" 은 두 시간 뒤", parseRunAt("+2h", now).toISOString() === "2026-10-16T03:00:00.000Z");
  check("표시는 한국 시각", formatKst(new Date("2026-10-16T02:00:00Z")) === "2026-10-16 11:00:00");
  const throws = (input: string) => {
    try {
      parseRunAt(input, now);
      return false;
    } catch {
      return true;
    }
  };
  check("지난 날짜는 거절", throws("2026-10-15 11:00"));
  check("30일 넘게 먼 시각은 거절", throws("2026-12-25 11:00"));
  check("모르는 모양은 거절", throws("열한시"));
  check("없는 시각은 거절", throws("25:00"));
}

/* ---------------------------------------------------------------- 2. 도구 */

const owner = "alice";
const conv = await createConversation(owner, { title: "예약", model: "mock-model" });
{
  const made = (await scheduleTaskTool.execute(
    { run_at: "23:59", instruction: "brand.naver.com/cgv 에서 팝콘통을 장바구니에 담아줘" },
    { ownerId: owner, conversationId: conv.id, browserControl: true },
  )) as { id: string; useBrowser: boolean; runAtKst: string };
  check("크롬 제어가 켜진 턴의 예약은 크롬 작업", made.useBrowser === true);
  const listed = (await listScheduledTasksTool.execute({}, { ownerId: owner, conversationId: conv.id })) as Array<{ id: string; status: string }>;
  check("목록에 보인다", listed.some((t) => t.id === made.id && t.status === "pending"));
  await cancelScheduledTaskTool.execute({ id: made.id }, { ownerId: owner, conversationId: conv.id });
  const after = await listSchedules(owner);
  check("취소된다", after.find((t) => t.id === made.id)?.status === "cancelled");
  let refused = false;
  try {
    await scheduleTaskTool.execute({ run_at: "11:00", instruction: "x" }, { ownerId: owner, conversationId: conv.id });
  } catch {
    refused = true;
  }
  check("빈 지시는 거절", refused);
}

/* ---------------------------------------------------------------- 3. 실행 루프 */

{
  const now = Date.now();
  const serverTask = await createSchedule(owner, {
    conversationId: conv.id,
    instruction: "오늘 날씨 요약해줘",
    runAt: new Date(now + 1000),
    useBrowser: false,
  });
  const browserTask = await createSchedule(owner, {
    conversationId: conv.id,
    instruction: "팝콘통을 장바구니에 담아줘",
    runAt: new Date(now + 1000),
    useBrowser: true,
  });
  await runDueSchedules(now); // 아직 이르다
  check("시각 전에는 아무것도 하지 않는다", (await listSchedules(owner)).find((t) => t.id === serverTask.id)?.status === "pending");

  await runDueSchedules(now + 2000);
  // 서버 실행은 기다리지 않고 돈다 — 끝날 때까지 잠깐 기다린다.
  for (let i = 0; i < 50; i++) {
    if ((await listSchedules(owner)).find((t) => t.id === serverTask.id)?.status === "done") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const tasks = await listSchedules(owner);
  check("크롬이 필요 없는 예약은 서버가 실행한다", tasks.find((t) => t.id === serverTask.id)?.status === "done", JSON.stringify(tasks.find((t) => t.id === serverTask.id)));
  const conversation = await getConversation(owner, conv.id);
  const texts = conversation!.messages.map((m) => m.content);
  check("…지시가 예약 머리말과 함께 대화에 들어가고", texts.some((t) => /^\[예약 작업 · \d\d:\d\d\] 오늘 날씨 요약해줘$/.test(t)), JSON.stringify(texts));
  check("…답이 남는다", texts.includes("예약 답변입니다"));
  check("크롬 예약은 서버가 실행하지 않는다", tasks.find((t) => t.id === browserTask.id)?.status === "pending");

  await runDueSchedules(now + 1000 + GRACE_MS + 1000);
  const missed = (await listSchedules(owner)).find((t) => t.id === browserTask.id);
  check("아무도 맡지 않으면 GRACE 뒤 놓침", missed?.status === "missed");
  const afterMiss = await getConversation(owner, conv.id);
  check("…대화에 알린다", afterMiss!.messages.some((m) => m.role === "assistant" && m.content.startsWith("예약 작업을 실행하지 못했습니다")));
}

/* ------------------------------------------------- 3b. 추론에서 올린 답의 표시 */
// 화면은 contentPromotedFromReasoning 으로 "이 응답은 reasoning 필드에서 복원되었습니다."
// 를 붙인다(src/components/MessageItem.tsx). 대화 화면에서 보낸 턴은 이 표시를 남기는데,
// 예약 실행이 저장하는 메시지에서는 빠져 있었다.
{
  const promotedConv = await createConversation(owner, { title: "추론 예약", model: "mock-model" });
  const now = Date.now();
  const task = await createSchedule(owner, {
    conversationId: promotedConv.id,
    instruction: REASONING_ONLY_MARKER,
    runAt: new Date(now + 1000),
    useBrowser: false,
  });
  await runDueSchedules(now + 2000);
  for (let i = 0; i < 50; i++) {
    if ((await listSchedules(owner)).find((t) => t.id === task.id)?.status === "done") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const stored = (await getConversation(owner, promotedConv.id))!.messages.at(-1);
  check("추론만 낸 예약 턴도 답이 남는다", stored?.role === "assistant" && stored.content === "날씨를 생각해 보면 맑다.", JSON.stringify(stored));
  check("…추론에서 올린 답이라는 표시가 남는다", stored?.contentPromotedFromReasoning === true, JSON.stringify(stored));
}

/* ---------------------------------------------------------------- 4. 맡기·끝내기 */

{
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ownerId = String(req.headers["x-as"] ?? owner);
    next();
  });
  app.use("/api", schedulesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const post = (p: string, body?: unknown, as = owner) =>
    realFetch(`http://127.0.0.1:${port}/api${p}`, {
      method: "POST",
      headers: { "x-as": as, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  const later = await createSchedule(owner, { conversationId: conv.id, instruction: "나중", runAt: new Date(Date.now() + 10 * 60_000), useBrowser: true });
  check("너무 이른 맡기는 409", (await post(`/schedules/${later.id}/claim`)).status === 409);

  const due = await createSchedule(owner, { conversationId: conv.id, instruction: "지금", runAt: new Date(Date.now() + 5_000), useBrowser: true });
  const first = await post(`/schedules/${due.id}/claim`);
  const firstBody = (await first.json()) as { prompt?: string };
  check("시각 직전의 맡기는 성공", first.status === 200 && firstBody.prompt?.endsWith("지금"), JSON.stringify(firstBody));
  check("두 번째 맡기는 409(다른 탭)", (await post(`/schedules/${due.id}/claim`)).status === 409);
  check("다른 계정은 맡을 수 없다", (await post(`/schedules/${later.id}/claim`, {}, "mallory")).status === 409);
  check("끝을 알리면 done", (await post(`/schedules/${due.id}/finish`, { ok: true })).status === 200 && (await listSchedules(owner)).find((t) => t.id === due.id)?.status === "done");
  check("끝난 예약은 다시 끝낼 수 없다", (await post(`/schedules/${due.id}/finish`, { ok: false })).status === 404);
  check("대기 중 예약은 취소된다", (await post(`/schedules/${later.id}/cancel`)).status === 200);
  check("취소된 예약은 다시 취소할 수 없다", (await post(`/schedules/${later.id}/cancel`)).status === 404);
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
