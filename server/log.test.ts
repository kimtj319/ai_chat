// 로그 검사. `npm test` 로 돈다.
//
// 확인하려는 것: **요청마다 다른 id 가 붙고**, 그 id 가 비동기 경계를 넘어도
// 남아 있으며, 밖에서 온 id 는 이어 쓰되 **로그를 위조할 수 있는 값은 거절**
// 한다는 것. 그리고 레벨을 올리면 시끄러운 줄부터 사라진다는 것.
//
// console 을 감싸는 부분과 미들웨어는 자식 프로세스에서 본다 — 이 프로세스에서
// 감싸면 검사 자신의 출력까지 바뀌어 무엇을 보고 있는지 알 수 없게 된다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRequestId, levelEnabled, newRequestId, runWithRequestId, sanitizeRequestId } from "./log.js";

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

console.log("server/log.ts");

/* ------------------------------------------------------------- 들어온 id 검사 */

{
  check("평범한 id 는 그대로 쓴다", sanitizeRequestId("abc-123_X.9") === "abc-123_X.9");
  check("앞뒤 공백은 다듬는다", sanitizeRequestId("  a1  ") === "a1");
  // 로그 한 줄을 위조할 수 있는 값들.
  check("줄바꿈이 섞이면 거절", sanitizeRequestId("a\n[http] GET /fake 200") === null);
  check("캐리지리턴도 거절", sanitizeRequestId("a\rb") === null);
  check("공백이 섞이면 거절", sanitizeRequestId("a b") === null);
  check("대괄호도 거절", sanitizeRequestId("[admin]") === null);
  check("너무 길면 거절", sanitizeRequestId("x".repeat(65)) === null);
  check("빈 값 거절", sanitizeRequestId("") === null);
  check("문자열이 아니면 거절", sanitizeRequestId(123) === null);
}

/* ------------------------------------------------------------------ 새 id */

{
  const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
  check("만들 때마다 다르다", ids.size === 500, `${ids.size}/500`);
  check("짧고 읽기 쉽다", [...ids].every((id) => /^[0-9a-f]{8}$/.test(id)));
}

/* --------------------------------------------------- 비동기 경계를 넘는 문맥 */

{
  check("요청 밖에서는 id 가 없다", currentRequestId() === undefined);

  const seen: Array<string | undefined> = [];
  await runWithRequestId("aaaa1111", async () => {
    seen.push(currentRequestId());
    await new Promise((r) => setTimeout(r, 5));
    seen.push(currentRequestId()); // await 를 건너도 남아 있어야 한다
    await Promise.all([
      (async () => {
        await new Promise((r) => setImmediate(r));
        seen.push(currentRequestId());
      })(),
    ]);
  });
  check("await 를 건너도 id 가 남는다", seen.every((s) => s === "aaaa1111"), JSON.stringify(seen));
  check("끝나면 다시 밖이다", currentRequestId() === undefined);
}
{
  // 두 요청이 겹쳐 돌아도 서로의 id 를 보지 않아야 한다 — 이게 깨지면
  // 로그가 남의 요청을 가리킨다.
  const out: string[] = [];
  const one = runWithRequestId("1111", async () => {
    await new Promise((r) => setTimeout(r, 20));
    out.push(`one=${currentRequestId()}`);
  });
  const two = runWithRequestId("2222", async () => {
    await new Promise((r) => setTimeout(r, 5));
    out.push(`two=${currentRequestId()}`);
  });
  await Promise.all([one, two]);
  check("겹쳐 돌아도 섞이지 않는다", out.includes("one=1111") && out.includes("two=2222"), JSON.stringify(out));
}

/* ------------------------------------------------------------------- 레벨 */

{
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  check("warn 이면 info 는 빠진다", !levelEnabled("info"));
  check("warn 이면 warn 은 남는다", levelEnabled("warn"));
  check("warn 이면 error 도 남는다", levelEnabled("error"));
  process.env.LOG_LEVEL = "debug";
  check("debug 이면 전부 남는다", levelEnabled("debug") && levelEnabled("info"));
  process.env.LOG_LEVEL = "silent";
  check("silent 이면 error 조차 빠진다", !levelEnabled("error"));
  process.env.LOG_LEVEL = "아무말";
  check("모르는 값이면 info 로 돈다", !levelEnabled("debug") && levelEnabled("info"));
  delete process.env.LOG_LEVEL;
  check("설정 없으면 info", !levelEnabled("debug") && levelEnabled("info"));
  if (saved !== undefined) process.env.LOG_LEVEL = saved;
}

/* ------------------------------- console 감싸기와 미들웨어 (자식 프로세스) */

const here = path.dirname(fileURLToPath(import.meta.url));
// 픽스처는 **저장소 안에** 둔다. /tmp 에 두면 node 가 위로 거슬러 올라가며
// node_modules 를 찾다가 express 를 못 만난다.
const tmpDir = fs.mkdtempSync(path.join(here, "..", ".test-tmp-"));
const fixture = path.join(tmpDir, "fixture.mts");
fs.writeFileSync(
  fixture,
  `
import express from "express";
import { installRequestIdPrefix } from ${JSON.stringify(path.join(here, "log.ts"))};
import { requestLog } from ${JSON.stringify(path.join(here, "middleware", "requestLog.ts"))};

installRequestIdPrefix();
const app = express();
app.use(requestLog);
app.get("/ok", (_req, res) => { console.log("[handler] 안에서 남긴 줄"); res.json({ ok: true }); });
app.get("/bad", (_req, res) => res.status(404).json({ error: "no" }));
app.get("/boom", (_req, res) => res.status(500).json({ error: "x" }));
const server = app.listen(0, () => {
  console.log("READY " + (server.address() as any).port);
});
`,
);

const child = spawn(process.execPath, ["--import", "tsx", fixture], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (b) => { out += String(b); });
child.stderr.on("data", (b) => { out += String(b); });

const port = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("자식이 준비되지 않았습니다: " + out)), 15000);
  const tick = setInterval(() => {
    const m = /READY (\d+)/.exec(out);
    if (m) { clearInterval(tick); clearTimeout(timer); resolve(Number(m[1])); }
  }, 50);
});

{
  const res = await fetch(`http://127.0.0.1:${port}/ok`);
  const id = res.headers.get("x-request-id") ?? "";
  check("응답에 요청 id 를 돌려준다", /^[0-9a-f]{8}$/.test(id), id);

  const res2 = await fetch(`http://127.0.0.1:${port}/ok`);
  check("요청마다 다른 id 다", res2.headers.get("x-request-id") !== id);

  const given = await fetch(`http://127.0.0.1:${port}/ok`, { headers: { "X-Request-Id": "upstream-77" } });
  check("밖에서 온 id 는 이어 쓴다", given.headers.get("x-request-id") === "upstream-77");

  const forged = await fetch(`http://127.0.0.1:${port}/ok`, { headers: { "X-Request-Id": "a_b_c_" + "d".repeat(80) } });
  check("쓸 수 없는 id 는 새로 만든다", /^[0-9a-f]{8}$/.test(forged.headers.get("x-request-id") ?? ""));

  await new Promise((r) => setTimeout(r, 200));
  check("요청 한 건에 한 줄이 남는다", /\[http\] GET \/ok 200 \d+ms/.test(out), out.slice(-300));
  check("핸들러 안의 줄에도 같은 id 가 붙는다", new RegExp(`\\[upstream-77\\] \\[handler\\]`).test(out), out.slice(-400));
}
{
  await fetch(`http://127.0.0.1:${port}/bad`);
  await fetch(`http://127.0.0.1:${port}/boom`);
  await new Promise((r) => setTimeout(r, 200));
  check("404 도 남는다", /\[http\] GET \/bad 404/.test(out), out.slice(-300));
  check("500 도 남는다", /\[http\] GET \/boom 500/.test(out), out.slice(-300));
}

child.kill("SIGKILL");
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
