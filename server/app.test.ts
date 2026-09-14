// 정적 파일 서빙 검사. `npm test` 로 돈다.
//
// 확인하려는 것: **없는 자산은 없다고 말한다.**
//
// SPA 는 모르는 경로를 전부 index.html 로 받아 넘긴다 — 그래야 /#/documents 를
// 새로고침해도 앱이 뜬다. 그런데 그 폴백이 /assets/ 까지 삼키면, 배포 때 치운
// 지난 번들을 옛 index.html 이 부를 때 **자바스크립트 자리에 HTML 이 200 으로**
// 돌아온다. 브라우저는 그것을 파싱하다 실패하고 화면은 비어 버리며, 로그에도
// 서버에도 잘못됐다는 흔적이 없다.
//
// 배포 때마다 지난 번들을 치우기로 한 이상 이 요청은 반드시 생긴다. 404 는
// 그때 브라우저가 새로고침으로 회복할 수 있는 유일한 답이다.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "app-test-"));
process.env.DATA_DIR = dataDir;

const { createApp } = await import("./app.js");

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

const server = createApp().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;
const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);

console.log("server/app.ts — 정적 서빙");

/* ------------------------------------------------ 없는 자산은 404 다 */

{
  for (const p of [
    "/assets/index-DDS4L51Q.js", // 실제로 오늘 치운 번들
    "/assets/index-oldhash.css",
    "/assets/없는폰트.woff2",
    "/assets/",
  ]) {
    const res = await get(p);
    check(`없는 자산은 404: ${p}`, res.status === 404, String(res.status));
    const type = res.headers.get("content-type") ?? "";
    check(`  그리고 HTML 을 돌려주지 않는다: ${p}`, !type.includes("text/html"), type);
  }
}
{
  // 이게 핵심이다 — 예전에는 여기서 200 + text/html 이 나왔다.
  const res = await get("/assets/index-DDS4L51Q.js");
  const body = await res.text();
  check("옛 번들 요청에 index.html 이 섞여 나오지 않는다", !body.includes("<!doctype html"), body.slice(0, 60));
  check("사람이 읽을 안내가 들어 있다", body.includes("새로고침"), body.slice(0, 80));
}

/* --------------------------------- 앱 경로는 여전히 index.html 로 간다 */

{
  // /assets 말고는 폴백이 그대로여야 한다. 안 그러면 새로고침에서 앱이 안 뜬다.
  for (const p of ["/", "/documents", "/아무/경로"]) {
    const res = await get(p);
    // dist 가 없는 검사 환경에서는 404 + "Not built" 가 정상이다. 어느 쪽이든
    // **/assets 의 404 와는 다른 길**을 탔다는 것이 확인하려는 바다.
    const body = await res.text();
    check(`앱 경로는 SPA 폴백을 탄다: ${p}`, !body.includes("새로고침해 주세요"), body.slice(0, 60));
  }
}

/* ------------------------------------------- /api 는 그대로 JSON 404 */

{
  // 로그인하지 않은 채로는 **있는 경로와 없는 경로가 똑같이 401** 이다.
  // 인증이 404 핸들러보다 앞에 서 있기 때문이고, 그게 맞다 — 익명 호출자에게
  // 어떤 API 가 있는지 알려 줄 이유가 없다.
  const missing = await get("/api/없는것");
  const real = await get("/api/conversations");
  check("로그인 전에는 모르는 /api 가 401", missing.status === 401, String(missing.status));
  check("있는 경로도 똑같이 401 — 무엇이 있는지 새지 않는다", real.status === missing.status, `${real.status} vs ${missing.status}`);
  check("  그리고 JSON 이다", (missing.headers.get("content-type") ?? "").includes("json"), missing.headers.get("content-type") ?? "");
  // 공개 경로는 인증을 지나간다.
  const open = await get("/api/health");
  check("공개 경로는 401 이 아니다", open.status !== 401, String(open.status));
}

server.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
