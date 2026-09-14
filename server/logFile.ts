/**
 * 로그를 날짜별 파일에 쓴다. 날짜가 바뀌면 파일도 바뀐다.
 *
 * 예전에는 기동 스크립트의 리다이렉션이 파일을 정했다 —
 * `node index.js >> log/container_$(date +%Y%m%d).log`. 셸은 그 이름을
 * 프로세스를 띄울 때 **한 번** 정하므로, 자정을 넘겨도 파일은 그대로다.
 * 9월 14일 오전의 기록이 container_20260913.log 에 쌓이고 있었고, 날짜로
 * 로그를 찾는 사람은 그날 아무 일도 없었다고 읽게 된다.
 *
 * 그래서 프로세스가 직접 연다. 쓸 때마다 오늘 날짜를 보고, 바뀌었으면
 * 새 파일로 넘어간다.
 */
import fs from "node:fs";
import path from "node:path";

function today(): string {
  // 서버가 선 지역의 날짜. 로그를 보는 사람과 같은 달력을 쓴다.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

let stream: fs.WriteStream | null = null;
let streamDate = "";
let dir = "";

function streamFor(date: string): fs.WriteStream {
  if (stream && streamDate === date) return stream;
  stream?.end();
  stream = fs.createWriteStream(path.join(dir, `container_${date}.log`), { flags: "a" });
  streamDate = date;
  return stream;
}

/**
 * console.log/warn/error 를 날짜별 파일로도 흘려보낸다.
 *
 * stdout 은 건드리지 않고 더한다 — `docker logs` 로 보던 사람이 그대로 볼
 * 수 있어야 하고, 파일 쓰기가 실패하더라도 기록이 통째로 사라지면 안 된다.
 */
export function startFileLogging(logDir: string): void {
  dir = logDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn("[log] 로그 디렉터리를 만들지 못해 파일 기록을 켜지 않습니다:", err);
    return;
  }

  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const line = args
          .map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a)))
          .join(" ");
        streamFor(today()).write(line + "\n");
      } catch {
        // 로그를 못 남기는 것이 요청을 실패시킬 이유는 되지 않는다.
      }
    };
  }
  console.log(`[log] 파일 기록 시작: ${path.join(dir, `container_${today()}.log`)} (날짜가 바뀌면 파일도 바뀝니다)`);
}
