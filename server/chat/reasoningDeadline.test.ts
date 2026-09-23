// startTurnDeadline() 의 상태 기계 검사. `npx tsx server/chat/reasoningDeadline.test.ts` 로 돈다.
// (server 쪽 계약 검사와 나란히 있지만 npm test 스크립트에는 아직 없다 — 손으로
// 이 경로를 불러서 확인한다.)
//
// vLLM 도, express 도 없다 — 이 파일이 지키는 계약은 순전히 세 신호(클라이언트
// 취소·"normal" 모드의 안전 상한·"지금 답변하기")를 하나의 signal 로 합치고
// stopReason() 으로 다시 갈라내는 부분이다. toolLoop.test.ts 의 시나리오 D 는
// 이 상태 기계가 실제 도구 루프에 제대로 배선됐는지를 보고, 여기서는 상태
// 기계 자체의 규칙만 본다.

process.env.DATA_DIR = process.env.DATA_DIR || "/tmp";
process.env.VLLM_ENDPOINTS = process.env.VLLM_ENDPOINTS || "mock|http://mock-vllm/v1";

const { startTurnDeadline } = await import("./reasoningDeadline.js");

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("server/chat/reasoningDeadline.ts — startTurnDeadline() 상태 기계");

/* ---- afterMs=null: "external" 모드는 스스로 끝나는 시각이 없다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  const deadline = startTurnDeadline(client.signal, null, answerNow.signal);

  await sleep(30);
  check(
    "afterMs=null 이면 시간이 지나도 스스로 끊기지 않는다",
    !deadline.signal.aborted && deadline.stopReason() === null,
    `aborted=${deadline.signal.aborted} reason=${deadline.stopReason()}`,
  );
  deadline.dispose();
}

/* ---- afterMs 로 설정한 안전 상한은 실제로 fires 한다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  const deadline = startTurnDeadline(client.signal, 20, answerNow.signal);

  check("타이머가 돌기 전에는 아직 안 끊겼다", !deadline.signal.aborted);
  await sleep(60);
  check(
    "안전 상한이 지나면 signal 이 끊기고 사유는 deadline 이다",
    deadline.signal.aborted && deadline.stopReason() === "deadline",
    `aborted=${deadline.signal.aborted} reason=${deadline.stopReason()}`,
  );
  deadline.dispose();
}

/* ---- 사용자의 "지금 답변하기" 클릭은 즉시, 그리고 동기적으로 반영된다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  // afterMs 는 일부러 아주 크게 둔다 — 타이머가 아니라 클릭이 원인임을 보인다.
  const deadline = startTurnDeadline(client.signal, 10 * 60 * 1000, answerNow.signal);

  answerNow.abort();
  check(
    "answerNowSignal.abort() 은 동기적으로 signal 을 끊고 사유를 answer-now 로 남긴다",
    deadline.signal.aborted && deadline.stopReason() === "answer-now",
    `aborted=${deadline.signal.aborted} reason=${deadline.stopReason()}`,
  );
  deadline.dispose();
}

/* ---- 클라이언트가 스스로 끊으면, 다른 사유가 먼저 발동했더라도 stopReason() 은 null 이다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  const deadline = startTurnDeadline(client.signal, 15, answerNow.signal);

  await sleep(40);
  check("(준비) 안전 상한이 먼저 발동했다", deadline.stopReason() === "deadline");

  client.abort();
  check(
    "클라이언트 취소가 나중에 와도 stopReason() 은 null 로 뒤집힌다 — 기다리는 사람이 없다",
    deadline.stopReason() === null,
    String(deadline.stopReason()),
  );
  deadline.dispose();
}

/* ---- 먼저 발동한 사유가 나중 트리거로 바뀌지 않는다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  const deadline = startTurnDeadline(client.signal, 15, answerNow.signal);

  await sleep(40);
  check("(준비) 안전 상한이 먼저 발동했다", deadline.stopReason() === "deadline");

  answerNow.abort(); // 이미 끝난 뒤의 클릭 — 사유를 answer-now 로 덮어써서는 안 된다.
  check(
    "안전 상한 발동 후의 클릭은 사유를 덮어쓰지 않는다",
    deadline.stopReason() === "deadline",
    String(deadline.stopReason()),
  );
  deadline.dispose();
}

/* ---- dispose() 이후에는 두 신호 모두 더 이상 영향을 주지 않는다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  const deadline = startTurnDeadline(client.signal, null, answerNow.signal);
  deadline.dispose();

  answerNow.abort();
  check(
    "dispose() 뒤의 answerNow abort() 는 아무 효과가 없다(리스너가 이미 떨어졌다)",
    !deadline.signal.aborted,
    `aborted=${deadline.signal.aborted}`,
  );

  client.abort();
  check(
    "dispose() 뒤의 클라이언트 abort() 도 마찬가지다",
    !deadline.signal.aborted,
    `aborted=${deadline.signal.aborted}`,
  );
}

/* ---- 이미 끊긴 answerNowSignal 을 건네면(경쟁 상태) 그 자리에서 바로 반영된다 ---- */
{
  const client = new AbortController();
  const answerNow = new AbortController();
  answerNow.abort();
  const deadline = startTurnDeadline(client.signal, null, answerNow.signal);

  check(
    "이미 끊긴 채로 들어온 answerNowSignal 도 즉시 반영된다",
    deadline.signal.aborted && deadline.stopReason() === "answer-now",
    `aborted=${deadline.signal.aborted} reason=${deadline.stopReason()}`,
  );
  deadline.dispose();
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
