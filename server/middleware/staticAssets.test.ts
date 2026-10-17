// 정적 파일 압축·캐시 검사. `npm test` 로 돈다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { accepts, staticAssets } from "./staticAssets.js";
import { compressJson } from "./compressJson.js";

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

console.log("server/middleware/staticAssets.ts + compressJson.ts");
check("br 를 받는다", accepts("gzip, deflate, br", "br"));
check("q=0 은 거절", !accepts("br;q=0, gzip", "br"));
check("없으면 아니다", !accepts(undefined, "gzip") && !accepts("identity", "gzip"));

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "static-test-"));
await fs.mkdir(path.join(dir, "assets"));
const js = "console.log('hello');".repeat(200);
await fs.writeFile(path.join(dir, "assets", "app-abc123.js"), js);
await fs.writeFile(path.join(dir, "assets", "app-abc123.js.br"), zlib.brotliCompressSync(js));
await fs.writeFile(path.join(dir, "assets", "app-abc123.js.gz"), zlib.gzipSync(js));
await fs.writeFile(path.join(dir, "assets", "raw-def.png"), Buffer.alloc(2000, 1));
await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>x</title>");

const app = express();
app.use("/api", compressJson());
app.get("/api/big", (_req, res) => res.json({ items: Array.from({ length: 500 }, (_, i) => ({ i, text: "같은 말이 반복된다" })) }));
app.get("/api/small", (_req, res) => res.json({ ok: true }));
app.use(...staticAssets(dir));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// fetch 는 압축을 풀어 버리므로 날 바이트를 보려면 node:http 를 쓴다.
import http from "node:http";
function raw(p: string, enc?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers: enc ? { "accept-encoding": enc } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

const br = await raw("/assets/app-abc123.js", "gzip, br");
check("br 를 받는 브라우저에는 .br 을", br.headers["content-encoding"] === "br" && zlib.brotliDecompressSync(br.body).toString() === js, JSON.stringify(br.headers));
check("형식은 원래 파일의 것", String(br.headers["content-type"]).includes("javascript"), String(br.headers["content-type"]));
check("해시 자산은 1년 immutable", br.headers["cache-control"] === "public, max-age=31536000, immutable", String(br.headers["cache-control"]));
check("Vary: Accept-Encoding", br.headers["vary"] === "Accept-Encoding");
const gz = await raw("/assets/app-abc123.js", "gzip");
check("gzip 만 받으면 .gz", gz.headers["content-encoding"] === "gzip" && zlib.gunzipSync(gz.body).toString() === js);
const plain = await raw("/assets/app-abc123.js");
check("압축을 못 받으면 원본", !plain.headers["content-encoding"] && plain.body.toString() === js);
check("원본에도 Vary(압축본이 있으므로)", plain.headers["vary"] === "Accept-Encoding");
const png = await raw("/assets/raw-def.png", "br");
check("압축본 없는 파일은 그대로, 캐시는 1년", !png.headers["content-encoding"] && png.headers["cache-control"]?.includes("immutable"));
const index = await raw("/", "br");
check("index.html 은 매번 확인(no-cache)", index.headers["cache-control"] === "no-cache", String(index.headers["cache-control"]));
const escape = await raw("/assets/..%2f..%2fetc%2fpasswd", "br");
check("경로 밖은 내주지 않는다", escape.status === 404 || escape.status === 403, String(escape.status));

const big = await raw("/api/big", "br");
const bigJson = JSON.parse(zlib.brotliDecompressSync(big.body).toString());
check("큰 JSON 은 br 로", big.headers["content-encoding"] === "br" && bigJson.items.length === 500);
check("JSON 형식이 남는다", String(big.headers["content-type"]).startsWith("application/json"));
check("압축으로 크게 준다", big.body.length < JSON.stringify(bigJson).length / 5, `${big.body.length}`);
const small = await raw("/api/small", "br");
check("작은 JSON 은 그대로", !small.headers["content-encoding"] && JSON.parse(small.body.toString()).ok === true);
const noEnc = await raw("/api/big");
check("압축을 못 받으면 평문 JSON", !noEnc.headers["content-encoding"] && JSON.parse(noEnc.body.toString()).items.length === 500);

server.close();
await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
