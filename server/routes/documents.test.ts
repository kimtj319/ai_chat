// 문서 PATCH(공개 범위 전환) 검사. `npm test` 로 돈다.
//
// 왜 필요한가: 운영에서 매뉴얼 한 건을 "모두에게 공개" 로 바꾸는 요청이
// 응답 없이 45초 가까이 걸렸다. PATCH 가 scope 만 바꾸면서도 매번
// `indexDocument` 전체 경로(청크를 새로 자르는 것까지 포함)를 그대로 타서
// 생긴 일이다 — 그 사이 연결이 끊기면(브라우저든 중간 프록시든) 서버는
// 뒤늦게 혼자 성공하고, 사용자에게는 "색인 실패"만 남는다. 확인하려는
// 것은 하나다: **이미 색인된 문서는 scope 만 바꿀 때 청크를 다시 자르지
// 않는다.** 엔진에 보낸 요청을 가로채 본문(BODY)이 기존 청크와 그대로인지,
// 삭제 없이 upsert 한 번으로 끝났는지를 확인한다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import http from "node:http";

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------- 가짜 검색엔진 */

interface Call {
  path: string;
  body: unknown;
}
const calls: Call[] = [];

const engine = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ header: { status: "success" } }));
});
engine.listen(0, "127.0.0.1");
await new Promise((r) => engine.once("listening", r));
const enginePort = (engine.address() as AddressInfo).port;

// config·경로는 로드 시점에 env 를 읽으므로 import 보다 먼저 세운다.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "documents-test-"));
process.env.DATA_DIR = dataDir;
process.env.RAG_ENGINE_URL = `http://127.0.0.1:${enginePort}`;
process.env.RAG_COLLECTION = "test";
// LLM 청킹은 일부러 설정하지 않는다 — 폴백 경로(실패했던 문서)가 규칙
// 기반으로 떨어지는 것까지 같이 확인하기 위해서다.
delete process.env.RAG_CHUNK_MODEL_URL;
delete process.env.RAG_CHUNK_MODEL;

const { documentsRouter } = await import("./documents.js");
const { saveDocumentMeta, saveDocumentChunks,
  saveDocumentText } = await import("../storage/documentStore.js");
type RagDocument = Parameters<typeof saveDocumentMeta>[1];

const OWNER = "alice";
const app = express();
app.use((req, _res, next) => {
  req.ownerId = OWNER;
  next();
});
app.use("/api", documentsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

async function patch(id: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/documents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

console.log("server/routes/documents.ts (PATCH)");

/* ------------------------------------------ 색인된 문서: 청크를 다시 안 자른다 */

{
  calls.length = 0;
  const now = new Date().toISOString();
  const doc: RagDocument = {
    id: "doc_ready01",
    name: "매뉴얼.pdf",
    mime: "application/pdf",
    bytes: 1000,
    chars: 1000,
    chunks: 2,
    chunkedBy: "llm",
    scope: "private",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  await saveDocumentMeta(OWNER, doc);
  // 표시문. LLM 이 골랐던 경계라 규칙 기반으로 다시 자르면 절대 이 모양이
  // 나오지 않는다 — 재사용되지 않았다면 이 문자열은 사라진다.
  const original = ["재사용-표시-청크-A", "재사용-표시-청크-B"];
  await saveDocumentChunks(OWNER, doc.id, original.map((text) => ({ text, overlapLen: 0 })));

  const { status, json } = await patch(doc.id, { scope: "shared" });

  eq("응답 200", status, 200);
  eq("scope 가 바뀐다", json.document?.scope, "shared");
  eq("청크 수는 그대로다", json.document?.chunks, 2);
  eq("chunkedBy 도 그대로다(다시 안 잘랐다는 뜻)", json.document?.chunkedBy, "llm");

  const indexCalls = calls.filter((c) => c.path === "/index/test");
  eq("엔진에 색인 요청이 한 번 간다", indexCalls.length, 1);
  const sentBodies = ((indexCalls[0]?.body ?? []) as Array<{ BODY: string; ACL: string }>).map((d) => d.BODY);
  check("보낸 본문이 기존 청크 그대로다", JSON.stringify(sentBodies) === JSON.stringify(original), JSON.stringify(sentBodies));
  check(
    "ACL 이 공유 키로 바뀐다",
    ((indexCalls[0]?.body ?? []) as Array<{ ACL: string }>).every((d) => d.ACL === "shared"),
    JSON.stringify(indexCalls[0]?.body),
  );

  const deleteCalls = calls.filter((c) => c.path === "/index/test/delete");
  eq("삭제는 한 번도 안 한다", deleteCalls.length, 0);

  const stored = await import("../storage/documentStore.js").then((m) => m.readDocumentChunks(OWNER, doc.id));
  const storedTexts = (stored ?? []).map((c) => (typeof c === "string" ? c : c.text));
  check("저장된 청크 파일도 그대로다", JSON.stringify(storedTexts) === JSON.stringify(original), JSON.stringify(storedTexts));
}

/* ----------------- 저장된 청크 수가 기록과 다르면 빠른 경로를 타지 않는다 */

{
  // 권한이 걸린 방어선이다. 빠른 경로는 같은 DOCID 를 덮어쓸 뿐 지우지 않으므로,
  // 저장된 청크가 기록(chunks)보다 적으면 남은 옛 청크가 이전 권한 그대로 검색에
  // 걸린다. 공개→비공개 전환이라면 비공개 문서가 모두에게 보인다는 뜻이다.
  calls.length = 0;
  const now = new Date().toISOString();
  const doc: RagDocument = {
    id: "doc_mismatch01",
    name: "어긋난.pdf",
    mime: "application/pdf",
    bytes: 1000,
    chars: 1000,
    chunks: 5, // 엔진에는 5개가 들어가 있다고 기록돼 있는데
    chunkedBy: "rule",
    scope: "shared",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  await saveDocumentMeta(OWNER, doc);
  await saveDocumentText(OWNER, doc.id, "어긋난 문서의 원문. ".repeat(40));
  // 청크 파일에는 2개뿐이다.
  await saveDocumentChunks(OWNER, doc.id, ["남은-A", "남은-B"].map((text) => ({ text, overlapLen: 0 })));

  const { status } = await patch(doc.id, { scope: "private" });
  eq("응답 200", status, 200);
  const deleteCalls = calls.filter((c) => c.path === "/index/test/delete");
  check("옛 청크를 기록된 수만큼 지운다 — 빠른 경로가 아니다", deleteCalls.length > 0, `delete ${deleteCalls.length}회`);
}

/* --------------------------------------------- 실패했던 문서: 원문부터 다시 자른다 */

{
  calls.length = 0;
  const now = new Date().toISOString();
  const doc: RagDocument = {
    id: "doc_failed01",
    name: "실패문서.txt",
    mime: "text/plain",
    bytes: 20,
    chars: 20,
    chunks: 0,
    chunkedBy: "rule",
    scope: "private",
    status: "failed",
    error: "검색 엔진에 연결하지 못했습니다.",
    createdAt: now,
    updatedAt: now,
  };
  await saveDocumentMeta(OWNER, doc);
  await saveDocumentText(OWNER, doc.id, "이전에 색인이 실패했던 짧은 문서 본문입니다.");

  const { status, json } = await patch(doc.id, { scope: "shared" });

  eq("응답 200", status, 200);
  eq("색인에 성공하면 ready 가 된다", json.document?.status, "ready");
  eq("규칙 기반으로 새로 잘랐다고 보고한다", json.document?.chunkedBy, "rule");
  const indexCalls = calls.filter((c) => c.path === "/index/test");
  check("이번에는 색인 요청이 실제로 나간다", indexCalls.length > 0, `${indexCalls.length}`);
}

/* -------------------------------------------------------------------- 결과 */

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
server.close();
engine.close();
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
