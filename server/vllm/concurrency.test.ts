// 모델별 동시 요청 상한(vllm/concurrency.ts). `npm test` 로 돈다.
import { acquireModelSlot, waitingAhead } from "./concurrency.js";

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
const tick = () => new Promise((r) => setTimeout(r, 5));

const never = new AbortController().signal;
const a = await acquireModelSlot("m1", never, 2);
const b = await acquireModelSlot("m1", never, 2);
check("상한까지는 기다리지 않는다", waitingAhead("m1", 2) === 0);
const order: string[] = [];
const c = acquireModelSlot("m1", never, 2).then((r) => (order.push("c"), r));
const d = acquireModelSlot("m1", never, 2).then((r) => (order.push("d"), r));
await tick();
check("상한을 넘으면 줄을 선다", order.length === 0 && waitingAhead("m1", 2) === 2, `${order} ${waitingAhead("m1", 2)}`);
const other = await Promise.race([acquireModelSlot("m2", never, 2), tick().then(() => null)]);
check("다른 모델은 따로 센다", typeof other === "function");
a();
a(); // 두 번 놓아도 한 칸만 비운다
await tick();
check("한 칸이 비면 먼저 선 사람부터", order.join() === "c", order.join());
b();
await tick();
check("순서대로", order.join() === "c,d", order.join());
(await c)();
(await d)();
check("다 놓으면 비어 있다", waitingAhead("m1", 2) === -1);

// 기다리다 그만두면 줄에서 빠지고 자리를 차지하지 않는다.
const x = await acquireModelSlot("m3", never, 1);
const quit = new AbortController();
const waiting = acquireModelSlot("m3", quit.signal, 1).then(
  () => "got",
  (err: Error) => err.name,
);
const next = acquireModelSlot("m3", never, 1).then((r) => (order.push("next"), r));
await tick();
quit.abort();
check("그만두면 AbortError", (await waiting) === "AbortError");
x();
await tick();
check("그만둔 사람은 건너뛰고 다음 사람이 받는다", order.includes("next"));
(await next)();
const before = new AbortController();
before.abort();
check("이미 그만둔 요청은 받지 않는다", (await acquireModelSlot("m4", before.signal, 1).then(() => "got", (e: Error) => e.name)) === "AbortError");
// 곁 호출은 먼저 섰어도 답을 기다리는 요청 뒤로 간다.
const held = await acquireModelSlot("m6", never, 1);
const got: string[] = [];
const side = acquireModelSlot("m6", never, 1, "side").then((r) => (got.push("side"), r));
const turn = acquireModelSlot("m6", never, 1, "turn").then((r) => (got.push("turn"), r));
await tick();
held();
await tick();
check("빈자리는 답을 기다리는 요청에게 먼저", got.join() === "turn", got.join());
(await turn)();
await tick();
check("그다음 곁 호출", got.join() === "turn,side", got.join());
(await side)();
check("상한 0 은 무제한", typeof (await acquireModelSlot("m5", never, 0)) === "function" && waitingAhead("m5", 0) === -1);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
