// 컨텍스트 압축 진행률 이벤트와 진행 중 기록 검사. `npm test` 로 돈다.
const { withCompactionEvents, compactionStatus, compactionSettled } = await import("./compactionProgress.js");

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

console.log("server/chat/compactionProgress.ts");

async function drain<T>(gen: AsyncGenerator<{ phase: string; progress: number; ok?: boolean }, T>) {
  const events: Array<{ phase: string; progress: number; ok?: boolean }> = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, value: step.value };
    events.push(step.value);
  }
}

const target = { ownerId: "alice", conversationId: "c1", kind: "history" as const };

{
  const { events, value } = await drain(withCompactionEvents(target, async () => 42, () => true));
  check("압축을 시작하지 않으면 이벤트가 없다", events.length === 0 && value === 42);
}

{
  let seenDuring: unknown = null;
  let settledDuring: Promise<void> | null = null;
  const { events, value } = await drain(
    withCompactionEvents(
      target,
      async (report) => {
        report(0);
        seenDuring = compactionStatus("alice", "c1");
        settledDuring = compactionSettled("c1");
        for (let i = 1; i <= 10; i++) {
          await new Promise((r) => setTimeout(r, 5));
          report(i / 10);
        }
        return "summary";
      },
      (v) => v === "summary",
    ),
  );
  check("start → progress → end 순서", events[0]?.phase === "start" && events.at(-1)?.phase === "end" && events.some((e) => e.phase === "progress"), JSON.stringify(events));
  check("끝은 성공으로 알린다", events.at(-1)?.ok === true && value === "summary");
  check("진행 중에는 그 계정에게 상태가 보인다", (seenDuring as { kind?: string } | null)?.kind === "history");
  check("다른 계정에게는 안 보인다", compactionStatus("mallory", "c1") === null);
  check("끝나면 기록이 지워진다", compactionStatus("alice", "c1") === null);
  let resolved = false;
  await Promise.race([settledDuring!.then(() => (resolved = true)), new Promise((r) => setTimeout(r, 100))]);
  check("…기다리던 쪽은 끝을 받는다", resolved);
}

{
  let threw = false;
  const gen = withCompactionEvents(target, async (report) => {
    report(0);
    throw new Error("boom");
  }, () => true);
  const events: Array<{ phase: string; ok?: boolean }> = [];
  try {
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      events.push(step.value);
    }
  } catch {
    threw = true;
  }
  check("실패하면 end(ok:false) 를 알리고 오류를 다시 던진다", threw && events.at(-1)?.phase === "end" && events.at(-1)?.ok === false, JSON.stringify(events));
  check("…기록도 남기지 않는다", compactionStatus("alice", "c1") === null);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
