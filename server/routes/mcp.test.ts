// server/routes/mcp.ts 의 hidden/adoption 스위치 검사.
// `npx tsx server/routes/mcp.test.ts` 로 돈다. (package.json 의 test 스크립트에는
// 아직 엮지 않았다.)
//
// board.test.ts 와 같은 이유로 라우트를 실제로 띄워서 본다: "자기 것만 건드릴
// 수 있다"는 라우트가 req.ownerId 를 쓰고 몸통(body)의 어떤 값도 그것을
// 대신하지 못한다는 것인데, 이건 스토어 함수만 불러서는 확인할 수 없다.
//
// 확인하는 것 셋.
//   1. GET /mcp/servers 응답이 새 계약(hidden)을 따르고 옛 계약
//      (optedOutBuiltins)을 더는 노출하지 않는다.
//   2. PUT .../hidden 과 PUT .../adoption 이 서로 다른 필드를 건드리고,
//      본문에 무엇을 실어도 req.ownerId 가 아닌 다른 계정은 절대 건드리지
//      못한다.
//   3. 입력 검증(불리언이 아니면 400, 없는 서버면 404)이 두 라우트 모두에서
//      지켜진다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-test-"));
process.env.DATA_DIR = dataDir;

const { mcpRouter } = await import("./mcp.js");
const { createServer, setServerStatus } = await import("../mcp/registryStore.js");
const { readOwnerPrefs } = await import("../mcp/ownerPrefs.js");

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

/* ------------------------------------------------------------------ 준비 */

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "bob");
  req.ownerId = who;
  req.user = { id: who, role: who === "admin" ? "admin" : "user" } as never;
  next();
});
app.use("/api", mcpRouter);

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

// status 를 active 로 두면 GET 이 스테일 캐시를 보고 실제 네트워크로 새로고침을
// 예약한다(scheduleRefresh) — 이 검사는 그 서버가 진짜로 응답하는지가 아니라
// hidden/adoption 라우트의 계약을 보는 것이므로, 등록 직후 곧장 비활성화해
// 네트워크를 타지 않게 한다.
const builtin = await createServer({
  name: "기본 서버",
  slug: "builtin-1",
  description: "검사용",
  url: "https://example.com/mcp",
  authMode: "none",
  createdBy: "system",
  origin: "builtin",
});
const shared = await createServer({
  name: "공유 서버",
  slug: "shared-1",
  description: "검사용",
  url: "https://example.com/mcp2",
  authMode: "none",
  createdBy: "alice",
  origin: "user",
});
if (!builtin.ok || !shared.ok) throw new Error("registry setup failed");
await setServerStatus(builtin.server.id, true, "system");
await setServerStatus(shared.server.id, true, "system");
const builtinId = builtin.server.id;
const sharedId = shared.server.id;

console.log("server/routes/mcp.ts");

/* ---------------------------------------------------------- GET 응답 계약 */

{
  const res = await call("bob", "GET", "/mcp/servers");
  check("GET 은 200", res.status === 200, String(res.status));
  check("서버 두 개가 보인다", res.json.servers.length === 2, String(res.json.servers?.length));
  check("hidden 필드를 준다", Array.isArray(res.json.hidden) && res.json.hidden.length === 0, JSON.stringify(res.json.hidden));
  check("adopted 필드를 준다", Array.isArray(res.json.adopted) && res.json.adopted.length === 0);
  check("옛 optedOutBuiltins 는 더는 실리지 않는다", !("optedOutBuiltins" in res.json), JSON.stringify(Object.keys(res.json)));
}

/* ------------------------------------------------------------ PUT hidden */

{
  const bad = await call("bob", "PUT", `/mcp/servers/${builtinId}/hidden`, { hidden: "yes" });
  check("hidden 이 불리언이 아니면 400", bad.status === 400 && bad.json.code === "invalid_input", `${bad.status} ${bad.json?.code}`);

  const missing = await call("bob", "PUT", "/mcp/servers/doesnotexist12/hidden", { hidden: true });
  check("없는 서버면 404", missing.status === 404 && missing.json.code === "not_found", `${missing.status} ${missing.json?.code}`);

  const on = await call("bob", "PUT", `/mcp/servers/${builtinId}/hidden`, { hidden: true });
  check("끄면 200과 hidden 목록을 돌려준다", on.status === 200 && on.json.hidden.includes(builtinId), JSON.stringify(on.json));
  check("adopted 는 이 응답에 없다(다른 필드다)", !("adopted" in on.json), JSON.stringify(Object.keys(on.json)));

  const after = await call("bob", "GET", "/mcp/servers");
  check("GET 에도 반영된다", after.json.hidden.includes(builtinId), JSON.stringify(after.json.hidden));
}

/* -------------------------------------------------- 자기 것만 건드릴 수 있다 */

{
  const carolBefore = await call("carol", "GET", "/mcp/servers");
  check("bob 이 끈 것이 carol 에게는 안 보인다", carolBefore.json.hidden.length === 0, JSON.stringify(carolBefore.json.hidden));

  // 몸통에 다른 계정을 실어도 소용없다 — 라우트는 req.ownerId 만 본다.
  await call("bob", "PUT", `/mcp/servers/${builtinId}/hidden`, { hidden: true, ownerId: "carol" });
  const carolAfter = await readOwnerPrefs("carol");
  check("몸통에 남의 계정을 적어도 그 계정 파일은 그대로다", carolAfter.hidden.length === 0, JSON.stringify(carolAfter));
}

/* --------------------------------------------------------- PUT adoption */

{
  const bad = await call("carol", "PUT", `/mcp/servers/${sharedId}/adoption`, { adopted: "예" });
  check("adopted 가 불리언이 아니면 400", bad.status === 400 && bad.json.code === "invalid_input", `${bad.status} ${bad.json?.code}`);

  const on = await call("carol", "PUT", `/mcp/servers/${sharedId}/adoption`, { adopted: true });
  check("채택하면 200과 adopted 목록을 돌려준다", on.status === 200 && on.json.adopted.includes(sharedId), JSON.stringify(on.json));
  check("hidden 은 이 응답에 없다(다른 필드다)", !("hidden" in on.json), JSON.stringify(Object.keys(on.json)));
  check("옛 optedOutBuiltins 도 없다", !("optedOutBuiltins" in on.json));

  const bobView = await call("bob", "GET", "/mcp/servers");
  check("carol 의 채택이 bob 에게는 안 보인다", !bobView.json.adopted.includes(sharedId), JSON.stringify(bobView.json.adopted));

  const carolView = await call("carol", "GET", "/mcp/servers");
  check("carol 자신에게는 보인다", carolView.json.adopted.includes(sharedId), JSON.stringify(carolView.json.adopted));
}

/* ------------------------------------------------ hidden 과 adoption 은 독립 */

{
  // carol 은 shared 를 채택한 채로 대화에서는 꺼둔다 — 라이브러리에는 남고
  // 피커/모델에게서만 빠지는 상태.
  await call("carol", "PUT", `/mcp/servers/${sharedId}/hidden`, { hidden: true });
  const prefs = await readOwnerPrefs("carol");
  check("채택은 유지된다", prefs.adopted.includes(sharedId));
  check("동시에 꺼진 상태다", prefs.hidden.includes(sharedId));
}

server.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
