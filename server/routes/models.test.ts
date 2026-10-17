// 모델 엔드포인트 라우트 검사. `npx tsx server/routes/models.test.ts` 로 돈다.
//
// 지키는 것은 하나다: **실패한 요청도 답을 받는다.** Express 4 는 async 핸들러가
// 던진 오류를 next 로 넘기지 않는다. 그런 핸들러에서 파일 쓰기가 실패하면 응답이
// 끝내 오지 않고, 화면은 자기 쪽 시한이 다할 때까지 멈춰 있다 — 서버 로그에는
// unhandledRejection 한 줄만 남는다.
//
// 여기서는 DELETE /models/endpoints 의 등록자 기록 정리(removeModelOwner)를 실패시킨다.
// model-owners.json 이 깨져 있으면 그 쓰기는 거절된다(storage/modelOwners.ts).
//
// config 는 불러들일 때 env 를 읽으므로 import 보다 먼저 세운다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "models-route-test-"));
process.env.DATA_DIR = root;
process.env.MODEL_ENDPOINTS_FILE = path.join(root, ".model");
process.env.VLLM_ENDPOINTS = "env|http://env-host.invalid/v1";
process.env.MODEL_CAPABILITY_PROBE = "0";
delete process.env.MODEL_ADMIN_TOKEN;

// 운영(lifecycle.ts)처럼 기록만 하고 넘어간다 — 그래야 "응답이 오지 않는다" 가 보인다.
process.on("unhandledRejection", (err) => console.log(`  (unhandledRejection: ${err instanceof Error ? err.message : err})`));

const { modelsRouter } = await import("./models.js");
const { modelOwnersFile } = await import("../storage/paths.js");

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

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const now = new Date().toISOString();
  req.user = {
    id: "admin",
    name: "관리자",
    email: "admin@example.com",
    passwordHash: "",
    status: "active",
    role: "admin",
    createdAt: now,
    updatedAt: now,
  };
  req.ownerId = "admin";
  next();
});
app.use("/api", modelsRouter);
// app.ts 의 오류 처리기 자리. next(err) 로 넘어오기만 하면 500 이 나간다.
app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: "internal" });
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

console.log("server/routes/models.ts");

{
  const baseUrl = "http://127.0.0.1:9/v1";
  await fs.writeFile(process.env.MODEL_ENDPOINTS_FILE!, `mine|${baseUrl}\n`);
  await fs.writeFile(modelOwnersFile(), "{ not json");

  let status = 0;
  let detail = "";
  try {
    const res = await fetch(`${base}/models/endpoints`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl }),
      signal: AbortSignal.timeout(3000),
    });
    status = res.status;
  } catch (err) {
    detail = err instanceof Error ? err.name : String(err);
  }
  check("뒷정리 쓰기가 실패해도 응답이 온다", status !== 0, detail || String(status));
  check("  └ 500 으로 알린다", status === 500, String(status));
}

server.close();
await fs.rm(root, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
