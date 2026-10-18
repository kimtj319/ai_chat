// GET /api/health 검사. `npm test` 로 돈다.
//
// 지키는 것: 탭마다 15초마다 부르는 확인이 모델 서버를 매번 두드리지 않는다. 10초 안의
// 확인은 앞선 결과(또는 진행 중인 확인)를 같이 쓰고, 응답 모양은 그대로다. 로그인하지
// 않은 확인은 모델 서버에 닿지도 않는다.
//
// config 는 불러들일 때 env 를 읽으므로 import 보다 먼저 세운다.
import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

let modelListings = 0;
const vllm = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    modelListings++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", max_model_len: 4096 }] }));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((resolve) => vllm.listen(0, "127.0.0.1", resolve));
const vllmPort = (vllm.address() as AddressInfo).port;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "health-route-test-"));
process.env.DATA_DIR = root;
process.env.MODEL_ENDPOINTS_FILE = "";
process.env.VLLM_ENDPOINTS = `fake|http://127.0.0.1:${vllmPort}/v1`;
process.env.MODEL_CAPABILITY_PROBE = "0";

const { healthRouter } = await import("./health.js");

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

const app = express();
app.use((req, _res, next) => {
  if (req.headers["x-signed-in"]) {
    const now = new Date().toISOString();
    req.user = { id: "u", name: "u", email: "u@example.com", passwordHash: "", status: "active", role: "user", createdAt: now, updatedAt: now };
    req.ownerId = "u";
  }
  next();
});
app.use("/api", healthRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
const get = async (signedIn = true) => (await fetch(base, { headers: signedIn ? { "x-signed-in": "1" } : {} })).json() as Promise<Record<string, unknown>>;

console.log("server/routes/health.ts");
try {
  const anonymous = await get(false);
  check("로그인 전 확인은 살아 있다는 것만", JSON.stringify(anonymous) === JSON.stringify({ backend: "ok", authenticated: false }), JSON.stringify(anonymous));
  check("로그인 전 확인은 모델 서버에 닿지 않는다", modelListings === 0, String(modelListings));

  const first = await get();
  check("응답 모양은 그대로", JSON.stringify(Object.keys(first)) === JSON.stringify(["backend", "vllm", "model", "latencyMs", "endpoints"]), JSON.stringify(Object.keys(first)));
  check("모델 서버 상태", first.vllm === "ok" && first.model === "fake-model");
  const endpoints = first.endpoints as Array<Record<string, unknown>>;
  check("엔드포인트별 상태도 그대로", endpoints.length === 1 && endpoints[0]!.ok === true && JSON.stringify(endpoints[0]!.models) === '["fake-model"]', JSON.stringify(endpoints));
  check("첫 확인은 모델 서버를 한 번 부른다", modelListings === 1, String(modelListings));

  await Promise.all([get(), get(), get()]);
  check("10초 안의 확인은 모델 서버를 다시 부르지 않는다", modelListings === 1, String(modelListings));

  const realNow = Date.now;
  Date.now = () => realNow() + 11_000;
  try {
    await get();
    check("10초가 지나면 다시 확인한다", modelListings === 2, String(modelListings));
  } finally {
    Date.now = realNow;
  }
} finally {
  server.close();
  vllm.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
