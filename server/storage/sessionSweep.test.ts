// 낡은 세션 기록 청소 검사. `npm test` 로 돈다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-sweep-"));
process.env.DATA_DIR = dataDir;
const { sweepStaleSessions } = await import("./sessionStore.js");

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

const now = Date.parse("2026-10-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
async function put(id: string, record: Record<string, unknown>) {
  await fs.mkdir(path.join(dataDir, "sessions", id), { recursive: true });
  await fs.writeFile(path.join(dataDir, "sessions", id, "session.json"), JSON.stringify({ sessionId: id, ...record }));
}
await put("live", { createdAt: hoursAgo(10), userId: "alice", loggedInAt: hoursAgo(10) });
await put("expired", { createdAt: hoursAgo(200), userId: "bob", loggedInAt: hoursAgo(200) });
await put("signed-out-old", { createdAt: hoursAgo(30) });
await put("signed-out-fresh", { createdAt: hoursAgo(2) });
await fs.mkdir(path.join(dataDir, "sessions", "no-record"), { recursive: true });

console.log("server/storage/sessionStore.ts (sweepStaleSessions)");
const removed = await sweepStaleSessions(168, now);
const left = (await fs.readdir(path.join(dataDir, "sessions"))).sort();
check("만료된 것과 하루 지난 로그아웃 기록만 지운다", removed === 2, String(removed));
check("살아 있는 세션은 남는다", left.includes("live"));
check("방금 로그아웃한 기록은 남는다(같은 쿠키로 곧 다시 온다)", left.includes("signed-out-fresh"));
check("기록 파일이 없는 폴더는 건드리지 않는다", left.includes("no-record"));
check("지운 것", !left.includes("expired") && !left.includes("signed-out-old"), left.join());
check("세션 폴더가 없어도 실패하지 않는다", (await (async () => { await fs.rm(path.join(dataDir, "sessions"), { recursive: true }); return sweepStaleSessions(168, now); })()) === 0);

await fs.rm(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
