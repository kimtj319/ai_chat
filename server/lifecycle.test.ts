// 종료 처리 검사. `npm test` 로 돈다.
//
// 이 파일은 다른 검사들과 달리 **자식 프로세스를 띄우고 진짜 신호를 보낸다.**
// 종료는 함수 하나의 결과가 아니라 프로세스가 어떻게 죽는가에 대한 것이라,
// process.exit 를 흉내 내서는 아무것도 확인하지 못한다. 확인하려는 것은 셋이다.
//
//   1. SIGTERM 을 받으면 **쓰고 있던 응답을 끝내고** 0 으로 나간다
//   2. 잡히지 않은 예외에 CRASH_POLICY=exit 이면 0 이 아닌 값으로 나간다
//   3. 같은 상황에 CRASH_POLICY=keep 이면 살아 있다
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = path.join(here, "lifecycle.ts");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));

/** 검사용 서버 하나. 느린 응답을 하나 열어 두고, 준비되면 포트를 알려 준다. */
const FIXTURE = `
import http from "node:http";
import { installLifecycle } from ${JSON.stringify(LIFECYCLE)};

const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
    // SIGTERM 이 도착한 뒤에도 끝나야 하는 응답.
    setTimeout(() => { res.writeHead(200); res.end("finished"); }, 600);
    return;
  }
  if (req.url === "/boom") {
    // 다음 틱에 던진다 — 이 요청의 try/catch 밖이라 잡히지 않는다.
    setTimeout(() => { throw new Error("의도적으로 터뜨림"); }, 10);
    res.writeHead(202);
    res.end("ok");
    return;
  }
  res.writeHead(200);
  res.end("ok");
});

server.listen(0, () => {
  installLifecycle(server);
  console.log("READY " + server.address().port);
});
`;
const fixture = path.join(tmpDir, "fixture.mts");
fs.writeFileSync(fixture, FIXTURE);

interface Run {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  alive: boolean;
}

/**
 * 자식을 띄우고 준비되기를 기다린 뒤, 주어진 일을 시키고 결과를 본다.
 * `after` 는 자식의 포트를 받아 무엇이든 한다(요청을 보내거나 신호를 보내거나).
 */
function run(env: Record<string, string>, after: (port: number, kill: (s: NodeJS.Signals) => void) => Promise<void>, waitMs = 4000): Promise<Run> {
  return new Promise((resolve) => {
    // npx 가 아니라 지금 도는 node 를 그대로 쓴다 — 해석 단계가 없어 빠르고,
    // 부모가 보낸 신호가 중간 프로세스를 거치지 않고 바로 닿는다.
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    let started = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, alive: boolean) => {
      if (settled) return;
      settled = true;
      if (alive) child.kill("SIGKILL");
      resolve({ exitCode, signal, stdout, alive });
    };

    child.stdout.on("data", (buf) => {
      stdout += String(buf);
      const m = /READY (\d+)/.exec(stdout);
      if (m && !started) {
        started = true;
        void after(Number(m[1]), (s) => child.kill(s));
      }
    });
    child.stderr.on("data", (buf) => {
      stdout += String(buf);
    });
    child.on("exit", (code, signal) => finish(code, signal, false));
    // 이 시간까지 살아 있으면 "살아 있다" 가 결과다.
    setTimeout(() => finish(null, null, true), waitMs).unref();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("server/lifecycle.ts");

/* ------------------------------------- 1. SIGTERM: 쓰던 응답을 끝내고 나간다 */

{
  let body = "";
  let bodyError = "";
  const result = await run({}, async (port, kill) => {
    // 느린 응답을 시작해 두고, 그 사이에 종료를 부탁한다.
    const pending = fetch(`http://127.0.0.1:${port}/slow`)
      .then((r) => r.text())
      .then((t) => { body = t; })
      .catch((e) => { bodyError = String(e); });
    await sleep(150);
    kill("SIGTERM");
    await pending;
  });

  check("SIGTERM 을 받으면 0 으로 나간다", result.exitCode === 0, `exit=${result.exitCode} signal=${result.signal}`);
  check("진행 중이던 응답을 끝까지 보낸다", body === "finished", `body=${JSON.stringify(body)} err=${bodyError}`);
  check("무엇을 하는지 로그로 말한다", /새 요청을 받지 않고/.test(result.stdout), result.stdout.slice(0, 200));
  check("끝났다고 로그로 말한다", /끝났습니다/.test(result.stdout), result.stdout.slice(-200));
}

/* ---------------------------------- 2. SIGTERM 뒤에는 새 요청을 받지 않는다 */

{
  // 진행 중인 요청이 하나도 없으면 종료가 곧바로 끝나 버려서 "그 사이" 라는 것이
  // 존재하지 않는다. 느린 응답 하나로 문을 붙잡아 둔 채로 확인한다.
  let second = "";
  await run({}, async (port, kill) => {
    const holding = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text()).catch(() => "");
    await sleep(150);
    kill("SIGTERM");
    await sleep(150);
    second = await fetch(`http://127.0.0.1:${port}/`)
      .then((r) => `HTTP ${r.status}`)
      .catch(() => "거절됨");
    await holding;
  });
  check("종료 절차가 시작되면 새 연결은 거절된다", second === "거절됨", second);
}

/* ------------------------------------------------- 3. 잡히지 않은 예외 정책 */

{
  const result = await run({ CRASH_POLICY: "exit" }, async (port) => {
    await fetch(`http://127.0.0.1:${port}/boom`).catch(() => {});
  });
  check("CRASH_POLICY=exit 이면 0 이 아닌 값으로 나간다", result.exitCode === 1, `exit=${result.exitCode} alive=${result.alive}`);
  check("무엇 때문인지 남긴다", /uncaughtException/.test(result.stdout), result.stdout.slice(-300));
}
{
  const result = await run({ CRASH_POLICY: "keep" }, async (port) => {
    await fetch(`http://127.0.0.1:${port}/boom`).catch(() => {});
  }, 2500);
  check("CRASH_POLICY=keep 이면 살아 있다", result.alive === true, `exit=${result.exitCode}`);
  check("대신 보장되지 않는다고 경고한다", /보장되지 않습니다/.test(result.stdout), result.stdout.slice(-300));
}
{
  // 기본값이 exit 이어야 한다 — 감시자가 있는 곳에서 옳은 쪽이 기본이다.
  const result = await run({}, async (port) => {
    await fetch(`http://127.0.0.1:${port}/boom`).catch(() => {});
  });
  check("기본값은 exit 이다", result.exitCode === 1, `exit=${result.exitCode} alive=${result.alive}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
