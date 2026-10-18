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
//
// 뒤쪽은 출처 창이 읽는 길이다: 업로드가 원본 글을 남기는지(나뉜 조각은 한 벌을
// 함께 가리키는지), /original 의 권한, 엔진에서 문서를 다시 엮는 /sources 의 겹침
// 제거와 권한(요청한 계정이 엔진으로 가는지).
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
/** 설정되면 다음 삭제 요청은 이 약속이 풀릴 때까지 답하지 않는다. */
let holdNextDelete: { arrived: () => void; release: Promise<void> } | null = null;
/** 가짜 엔진의 색인 내용(검색 응답용)과 계정별 권한 키. */
let searchRows: Array<{ DOCID: string; PARENT_ID: string; TITLE: string; SOURCE: string; ORD: string; BODY: string; ACL: string }> = [];
const engineAccounts = new Map<string, string[]>();

const engine = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
  if (req.url === "/search/test") {
    // 권한을 엔진처럼 흉내 낸다: 계정이 가진 키(공유 키 + 자기 키)의 청크만 돌려주고,
    // 키가 하나도 없는 계정은 엔진이 그러듯 400 이다.
    const body = JSON.parse(raw) as { authority?: { field?: string; account?: string } };
    const account = body.authority?.account ?? "";
    const keys = engineAccounts.get(account);
    if (!keys) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ header: { status: "error", message: "권한이 없는 계정입니다." } }));
      return;
    }
    const rows = searchRows.filter((r) => keys.includes(r.ACL)).map(({ ACL: _acl, ...fields }) => ({ fields }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ header: { status: "success" }, totalHits: rows.length, ...(rows.length ? { document: rows } : {}) }));
    return;
  }
  if (req.url === "/index/test/delete" && holdNextDelete) {
    const hold = holdNextDelete;
    holdNextDelete = null;
    hold.arrived();
    await hold.release;
  }
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
// 나뉜 업로드를 작은 파일로 만들어 보려고 한도를 낮춘다(아래 "조각" 검사).
process.env.RAG_DOC_MAX_BYTES = "4096";
// LLM 청킹은 일부러 설정하지 않는다 — 폴백 경로(실패했던 문서)가 규칙
// 기반으로 떨어지는 것까지 같이 확인하기 위해서다.
delete process.env.RAG_CHUNK_MODEL_URL;
delete process.env.RAG_CHUNK_MODEL;

const { documentsRouter } = await import("./documents.js");
const { getDocument, saveDocumentMeta, saveDocumentChunks,
  saveDocumentText } = await import("../storage/documentStore.js");
type RagDocument = Parameters<typeof saveDocumentMeta>[1];

const OWNER = "alice";
const app = express();
app.use((req, _res, next) => {
  // 남의 문서를 열어 보는 검사를 위해 요청마다 계정을 바꿀 수 있게 한다.
  req.ownerId = (req.headers["x-test-owner"] as string | undefined) ?? OWNER;
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

/* --------------------------- 지우는 중에 온 PATCH 는 지운 문서를 되살리지 않는다 */

{
  // PATCH 가 문서를 읽은 뒤 색인 잠금을 기다리는 사이에 DELETE 가 청크와 파일을
  // 지우면, PATCH 는 읽어 둔 사본으로 청크를 **공개로** 다시 넣고 메타 파일을 새로
  // 쓴다 — 지운 문서가 목록에 돌아오고 모두의 검색에 걸린다.
  calls.length = 0;
  const now = new Date().toISOString();
  const doc: RagDocument = {
    id: "doc_race01",
    name: "지울문서.md",
    mime: "text/markdown",
    bytes: 100,
    chars: 100,
    chunks: 2,
    chunkedBy: "rule",
    scope: "private",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  await saveDocumentMeta(OWNER, doc);
  await saveDocumentText(OWNER, doc.id, "지울 문서 원문.");
  await saveDocumentChunks(OWNER, doc.id, ["청크-A", "청크-B"].map((text) => ({ text, overlapLen: 0 })));

  let arrived!: () => void;
  const deleteArrived = new Promise<void>((r) => (arrived = r));
  let release!: () => void;
  holdNextDelete = { arrived, release: new Promise<void>((r) => (release = r)) };

  const deleting = fetch(`http://127.0.0.1:${port}/api/documents/${doc.id}`, { method: "DELETE" });
  await deleteArrived; // DELETE 가 색인 잠금 안에서 엔진을 기다리는 중
  const patching = patch(doc.id, { scope: "shared" });
  await new Promise((r) => setTimeout(r, 200)); // PATCH 가 문서를 읽고 잠금 앞에 줄을 선다
  release();
  const [deleted, patched] = await Promise.all([deleting, patching]);

  eq("DELETE 는 204", deleted.status, 204);
  eq("PATCH 는 그사이 지워진 문서라 404", patched.status, 404);
  check("지운 문서의 메타 파일이 되살아나지 않는다", (await getDocument(OWNER, doc.id)) === null);
  const deleteAt = calls.findIndex((c) => c.path === "/index/test/delete");
  const reindexed = calls.slice(deleteAt + 1).filter((c) => c.path === "/index/test");
  eq("지운 뒤에 엔진으로 색인 요청이 가지 않는다", reindexed.length, 0);
}

/* ----------------------------------------- 업로드: 원본 글을 그대로 남긴다 */

const { readDocumentOriginal, readDocumentText, listDocuments } = await import("../storage/documentStore.js");

async function upload(name: string, body: string): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/documents?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from(body, "utf8"),
  });
  const text = await res.text();
  const done = text
    .split("\n\n")
    .map((line) => line.replace(/^data: /, ""))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((e) => e.type === "done");
  return done?.documents ?? [];
}

async function getText(id: string, route: string, owner = OWNER): Promise<{ status: number; body: string; code?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/documents/${id}/${route}`, { headers: { "x-test-owner": owner } });
  const body = await res.text();
  let code: string | undefined;
  try {
    code = JSON.parse(body).code;
  } catch {
    // 본문이 글이면 오류 코드가 없다.
  }
  return { status: res.status, body, code };
}

let mdDocId = "";
{
  // 전처리가 바꾸는 것들(CRLF, 열 맞춤 공백, 소프트 하이픈, NFD)을 일부러 넣는다 —
  // 원본이 정리본과 다르다는 것이 보여야 "원본을 남겼다" 를 확인할 수 있다.
  const raw = "# 회의록\r\n\r\n| 항목    | 값   |\r\n|---|---|\r\n| 포트    | 9400 |\r\n\r\n결론: 소프트­하이픈과 " + "풀린 한글".normalize("NFD") + " 이 있다.\r\n";
  const docs = await upload("회의록.md", raw);
  eq("마크다운 업로드는 한 조각", docs.length, 1);
  const doc = docs[0] ?? {};
  mdDocId = doc.id;
  eq("조각의 originalId 는 자기 id", doc.originalId, doc.id);
  eq("원본 글이 바이트 그대로 남는다", await readDocumentOriginal(OWNER, doc.originalId), raw);
  check("색인용 본문(.txt)은 여전히 정리된 글이다", (await readDocumentText(OWNER, doc.id)) !== raw);

  const mine = await getText(doc.id, "original");
  eq("내 문서의 /original 은 200", mine.status, 200);
  eq("/original 은 원본 글을 돌려준다", mine.body, raw);
  const old = await getText(doc.id, "text");
  check("/text 는 예전처럼 정리된 글이다", old.status === 200 && old.body !== raw);

  const other = await getText(doc.id, "original", "bob");
  eq("남의 비공개 문서의 /original 은 404", other.status, 404);
  check("404 본문에 원본이 섞이지 않는다", !other.body.includes("회의록"), other.body);

  await saveDocumentMeta(OWNER, { ...doc, scope: "shared" });
  const shared = await getText(doc.id, "original", "bob");
  eq("공개 문서의 /original 은 남도 읽는다", shared.status, 200);
}

{
  // 원본을 남기기 전에 올린 문서: originalId 가 없다. 화면은 /text 로 물러선다.
  const now = new Date().toISOString();
  await saveDocumentMeta(OWNER, {
    id: "doc_legacy01", name: "예전.md", mime: "text/markdown", bytes: 10, chars: 10, chunks: 1,
    chunkedBy: "rule", scope: "private", status: "ready", createdAt: now, updatedAt: now,
  });
  await saveDocumentText(OWNER, "doc_legacy01", "예전 문서 본문.");
  const r = await getText("doc_legacy01", "original");
  check("예전 문서의 /original 은 404 no_source", r.status === 404 && r.code === "no_source", JSON.stringify(r));
  eq("예전 문서의 /text 는 그대로 200", (await getText("doc_legacy01", "text")).status, 200);
}

{
  // 한 파일이 여러 조각으로 나뉘어도 원본은 한 벌이고, 조각마다 같은 원본을 가리킨다.
  // 텍스트 파일이 나뉘는 길: NFC 로 모으면 글이 길어지는 글자(U+0344 → 두 글자)가 많으면
  // 정리본이 한도를 넘는다. 바이트 한도는 이 검사에서 4096 이다.
  const marks = "̈́".repeat(30);
  const raw = Array.from({ length: 40 }, (_, i) => `## 절 ${i}\n\n본문 ${i} ${marks} 끝.\n`).join("\n");
  check("검사 전제: 올린 파일은 한도 안이다", Buffer.byteLength(raw, "utf8") <= 4096, String(Buffer.byteLength(raw, "utf8")));
  const parts = await upload("긴글.md", raw);
  check("두 조각 이상으로 나뉜다", parts.length >= 2, String(parts.length));
  const originalId = parts[0]?.originalId;
  check("모든 조각이 같은 원본을 가리킨다", parts.every((p) => p.originalId === originalId), JSON.stringify(parts.map((p) => p.originalId)));
  eq("원본은 첫 조각 id 로 한 벌", originalId, parts[0]?.id);
  const files = await fs.readdir(path.join(dataDir, "owners", OWNER, "documents"));
  eq("원본 파일은 하나뿐이다", files.filter((f) => f.endsWith(".original.txt") && parts.some((p) => f.startsWith(p.id))).length, 1);
  const second = (await getText(parts[1].id, "original")).body;
  check("둘째 조각의 /original 도 파일 전체 원본이다", second === raw, `${second.length}자 / 원본 ${raw.length}자`);

  // 조각 일부만 공개하면 남에게 원본을 주지 않는다 — 원본에는 공개하지 않은 조각의 글도 있다.
  for (const p of parts) await saveDocumentMeta(OWNER, { ...p, scope: "shared", status: "ready" });
  eq("조각이 모두 공개면 남도 원본을 읽는다", (await getText(parts[0].id, "original", "bob")).status, 200);
  await saveDocumentMeta(OWNER, { ...parts[1], scope: "private", status: "ready" });
  const restricted = await getText(parts[0].id, "original", "bob");
  check("비공개 조각이 섞인 원본은 남에게 404", restricted.status === 404 && !restricted.body.includes("본문 1"), JSON.stringify(restricted).slice(0, 200));
  eq("주인은 여전히 원본을 읽는다", (await getText(parts[0].id, "original")).status, 200);

  // 첫 조각을 지워도 남은 조각은 원본을 잃지 않는다. 마지막 조각이 지워질 때 원본도 지운다.
  await fetch(`http://127.0.0.1:${port}/api/documents/${parts[0].id}`, { method: "DELETE" });
  const kept = (await getText(parts[1].id, "original")).body;
  check("첫 조각을 지워도 원본은 남는다", kept === raw, `${kept.length}자 / 원본 ${raw.length}자`);
  for (const p of parts.slice(1)) await fetch(`http://127.0.0.1:${port}/api/documents/${p.id}`, { method: "DELETE" });
  eq("마지막 조각을 지우면 원본도 지워진다", await readDocumentOriginal(OWNER, originalId), null);
  check("목록에서도 다 사라졌다", !(await listDocuments(OWNER)).some((d) => d.originalId === originalId));
}

/* ------------------------- 엔진에만 있는 문서: 색인에서 다시 엮어 보여 준다 */

async function getSource(parentId: string, owner = OWNER): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sources/${encodeURIComponent(parentId)}`, { headers: { "x-test-owner": owner } });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

{
  // 시드 코퍼스처럼 웹 문서 저장소에 없는 문서. 청크는 규칙 청커와 같은 겹침을 가진다:
  // 둘째 청크부터 앞 청크 꼬리 + "\n" + 자기 본문.
  calls.length = 0;
  const bodies = ["첫째 문단입니다. 엔진은 문서를 나눕니다.", "둘째 문단입니다. 벡터를 만듭니다.", "셋째 문단입니다. 끝입니다."];
  const chunkTexts = [bodies[0]!, `엔진은 문서를 나눕니다.\n${bodies[1]}`, `벡터를 만듭니다.\n${bodies[2]}`];
  const row = (ord: number, parent = "03-커밋과-배치", acl = "shared") => ({
    DOCID: `${parent}#${String(ord).padStart(3, "0")}`, PARENT_ID: parent, TITLE: "커밋과 배치", SOURCE: "커밋과 배치", ORD: String(ord),
    BODY: chunkTexts[ord] ?? "", ACL: acl,
  });
  // 엔진이 순서 없이 돌려주고, 형태소 일치로 다른 문서의 청크가 섞여 와도 걸러야 한다.
  searchRows = [row(2), row(0), row(1), row(0, "03-커밋과", "shared"), row(5, "doc_private", "u_carol")];
  engineAccounts.set("alice", ["shared", "u_alice"]);
  engineAccounts.set("carol", ["shared", "u_carol"]);

  const { status, json } = await getSource("03-커밋과-배치");
  eq("엔진 재구성은 200", status, 200);
  eq("겹침을 빼고 순서대로 이어 붙인다", json?.text, bodies.join("\n\n"));
  eq("제목", json?.title, "커밋과 배치");
  const c1 = (json?.chunks ?? []).find((c: any) => c.ord === 1);
  eq("둘째 청크의 칠할 자리는 겹친 꼬리부터다", json?.text.slice(c1?.start, c1?.end), `엔진은 문서를 나눕니다.\n\n${bodies[1]}`);
  eq("다른 PARENT_ID 의 청크는 섞이지 않는다", (json?.chunks ?? []).length, 3);

  const search = calls.find((c) => c.path === "/search/test")?.body as any;
  eq("요청 계정이 엔진 권한으로 간다", search?.authority?.account, "alice");
  eq("권한 필드는 ACL", search?.authority?.field, "ACL");
  eq("PARENT_ID 로 고른다", search?.filterQuery, "<PARENT_ID:MATCH:03-커밋과-배치>");
  eq("상한 200", search?.size, 200);

  eq("남의 비공개 문서는 엔진이 주지 않으므로 404", (await getSource("doc_private")).status, 404);
  eq("그 주인에게는 보인다", (await getSource("doc_private", "carol")).status, 200);
  eq("엔진이 모르는 계정은 404(오류를 드러내지 않는다)", (await getSource("03-커밋과-배치", "dave")).status, 404);
  eq("필터 문법을 깨는 id 는 엔진에 보내지 않고 404", (await getSource("a>b&c")).status, 404);
}

{
  // 순번이 비면(상한에 걸렸거나 한 청크가 빠졌으면) 앞 청크는 진짜 앞이 아니므로 겹침을 빼지 않는다.
  const { joinChunks, overlapLength } = await import("../rag/engineSource.js");
  const { text } = joinChunks([
    { ord: 0, text: "가나다 라마바." },
    { ord: 2, text: "라마바.\n사아자." },
  ]);
  eq("순번이 비면 겹침처럼 보여도 그대로 둔다", text, "가나다 라마바.\n\n라마바.\n사아자.");
  eq("겹침이 없는 청크는 0", overlapLength("앞 청크 끝.", "새 문단\n둘째 줄"), 0);
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
