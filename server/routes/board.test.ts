// 문의 게시판 검사. `npm test` 로 돈다.
//
// 확인하려는 것은 둘이다.
//
//   1. **남의 글을 남이 닫거나 지우지 못한다.** 게시판은 이 저장소에서 유일하게
//      모든 계정이 서로의 레코드를 보는 곳이다. 문서는 디렉터리가 갈라 주지만
//      글은 한 폴더에 함께 있으므로, 경계를 지키는 것은 canManage 한 줄뿐이다.
//      그 줄이 틀리면 아무 오류 없이 남의 글이 닫힌다.
//
//   2. **태그가 하나로 모인다.** 사용자가 자유롭게 적는 값이라, 다듬지 않으면
//      "검색" 과 "검색 " 과 "Search" 가 서로 다른 태그가 되어 거르기가 무의미해진다.
//
// 라우트를 실제로 띄워서 본다. 권한은 라우트에만 있고 저장소는 시키는 대로
// 쓰므로, 저장소만 불러서는 1번을 확인할 수 없기 때문이다.
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-test-"));
process.env.DATA_DIR = dataDir;

const { boardRouter } = await import("./board.js");
const { normalizeTags } = await import("../storage/boardStore.js");

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

// 인증을 흉내 낸다: X-As 헤더가 곧 계정이고, "admin" 이면 관리자다.
// 진짜 인증은 auth.test.ts 가 따로 본다 — 여기서 보려는 것은 그 다음 칸이다.
const app = express();
app.use((req, _res, next) => {
  const who = String(req.headers["x-as"] ?? "alice");
  req.ownerId = who;
  req.user = { id: who, role: who === "admin" ? "admin" : "user" } as never;
  next();
});
app.use("/api", boardRouter);

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

async function call(
  as: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${p}`, {
    method,
    headers: { "x-as": as, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

console.log("server/routes/board.ts + storage/boardStore.ts");

/* ----------------------------------------------------------- 태그 다듬기 */

{
  check("공백은 하이픈이 된다", normalizeTags(["검색 엔진"]).join() === "검색-엔진", normalizeTags(["검색 엔진"]).join());
  check("대소문자를 하나로 모은다", normalizeTags(["Search", "SEARCH", "search"]).join() === "search", normalizeTags(["Search", "SEARCH", "search"]).join());
  check("앞뒤 공백만 다른 것은 같은 태그다", normalizeTags([" 검색 ", "검색"]).join() === "검색", normalizeTags([" 검색 ", "검색"]).join());
  check("앞에 붙은 # 은 뗀다", normalizeTags(["#색인"]).join() === "색인", normalizeTags(["#색인"]).join());
  check("빈 값은 버린다", normalizeTags(["", "  ", "#", "-"]).length === 0, JSON.stringify(normalizeTags(["", "  ", "#", "-"])));
  check("문자열 하나는 쉼표로 가른다", normalizeTags("가, 나 ,다").join() === "가,나,다", normalizeTags("가, 나 ,다").join());
  check("여덟 개를 넘지 않는다", normalizeTags(["1","2","3","4","5","6","7","8","9","10"]).length === 8);
  check("스물넷 자를 넘으면 자른다", normalizeTags(["가".repeat(40)])[0].length === 24);
  check("배열도 문자열도 아니면 빈 목록", normalizeTags(null).length === 0 && normalizeTags(42).length === 0);
  check("문자열 아닌 항목은 건너뛴다", normalizeTags(["검색", 7, null, "색인"]).join() === "검색,색인", normalizeTags(["검색", 7, null, "색인"]).join());
}

/* --------------------------------------------------------------- 글쓰기 */

let postId = "";
{
  const bad = await call("alice", "POST", "/board", { title: "   ", body: "내용" });
  check("제목이 비면 400", bad.status === 400 && bad.json.code === "invalid_input", `${bad.status} ${bad.json?.code}`);

  const res = await call("alice", "POST", "/board", {
    title: "색인이 안 됩니다",
    body: "5MB pdf 를 올리면 멈춥니다.",
    tags: ["색인", " 색인 ", "PDF"],
  });
  postId = res.json?.post?.id ?? "";
  check("글이 만들어진다", res.status === 201 && postId.startsWith("post_"), `${res.status} ${postId}`);
  check("새 글은 열린 상태다", res.json.post.status === "open", res.json?.post?.status);
  check("태그 중복이 하나로 합쳐진다", res.json.post.tags.join() === "색인,pdf", res.json?.post?.tags?.join());
  check("답변은 비어 있다", Array.isArray(res.json.post.replies) && res.json.post.replies.length === 0);
  check("쓴 사람은 자기 글을 관리할 수 있다", res.json.post.canManage === true);
}

/* ------------------------------------------------------- 권한: 이 파일의 요점 */

{
  const stranger = await call("bob", "GET", `/board/${postId}`);
  check("남의 글도 읽을 수는 있다 — 게시판이니까", stranger.status === 200, String(stranger.status));
  check("  하지만 관리할 수는 없다고 말해 준다", stranger.json.post.canManage === false, String(stranger.json?.post?.canManage));

  const close = await call("bob", "PATCH", `/board/${postId}`, { status: "closed" });
  check("남이 닫으려 하면 403", close.status === 403 && close.json.code === "forbidden", `${close.status} ${close.json?.code}`);

  const del = await call("bob", "DELETE", `/board/${postId}`);
  check("남이 지우려 하면 403", del.status === 403 && del.json.code === "forbidden", `${del.status} ${del.json?.code}`);

  // 403 이 돌아왔다고 끝이 아니다 — 정말 안 바뀌었는지 본다.
  const after = await call("alice", "GET", `/board/${postId}`);
  check("막힌 뒤에도 글은 그대로 열려 있다", after.json.post.status === "open", after.json?.post?.status);
}

/* --------------------------------------------------------------- 답변 */

{
  const empty = await call("bob", "POST", `/board/${postId}/replies`, { body: "  " });
  check("빈 답변은 400", empty.status === 400 && empty.json.code === "invalid_input", `${empty.status} ${empty.json?.code}`);

  const reply = await call("bob", "POST", `/board/${postId}/replies`, { body: "전처리 모듈이 붙기 전 파일인가요?" });
  check("남도 답변은 달 수 있다", reply.status === 201, String(reply.status));
  check("답변이 글에 붙는다", reply.json.post.replies.length === 1, String(reply.json?.post?.replies?.length));
  check("답변에 쓴 사람이 남는다", reply.json.post.replies[0].authorId === "bob", reply.json?.post?.replies?.[0]?.authorId);
  check("답변이 달렸다고 상태가 변하지는 않는다", reply.json.post.status === "open", reply.json?.post?.status);

  const missing = await call("bob", "POST", "/board/post_없는글/replies", { body: "안녕" });
  check("없는 글에 답변하면 404", missing.status === 404 && missing.json.code === "not_found", `${missing.status} ${missing.json?.code}`);
}

/* ------------------------------------------------------------ 열고 닫기 */

{
  const closed = await call("alice", "PATCH", `/board/${postId}`, { status: "closed" });
  check("쓴 사람은 닫을 수 있다", closed.status === 200 && closed.json.post.status === "closed", `${closed.status} ${closed.json?.post?.status}`);
  check("닫은 사람과 시각이 남는다", closed.json.post.closedBy === "alice" && typeof closed.json.post.closedAt === "string", JSON.stringify(closed.json?.post?.closedBy));

  const reopened = await call("admin", "PATCH", `/board/${postId}`, { status: "open" });
  check("관리자는 남의 글도 다시 열 수 있다", reopened.status === 200 && reopened.json.post.status === "open", `${reopened.status} ${reopened.json?.post?.status}`);
  // 닫은 기록이 남아 있으면 "닫힌 적 있는 열린 글" 이 되어 화면이 무엇을 보여
  // 줄지 모르게 된다.
  check("다시 열면 닫은 기록이 지워진다", reopened.json.post.closedBy === undefined && reopened.json.post.closedAt === undefined, JSON.stringify(reopened.json?.post));

  const bogus = await call("alice", "PATCH", `/board/${postId}`, { status: "어중간" });
  check("모르는 상태는 400", bogus.status === 400 && bogus.json.code === "invalid_input", `${bogus.status} ${bogus.json?.code}`);
}

/* --------------------------------------------------------------- 목록 */

{
  await call("bob", "POST", "/board", { title: "두 번째 문의", tags: ["검색"] });
  const second = await call("admin", "POST", "/board", { title: "세 번째 문의" });
  await call("admin", "PATCH", `/board/${second.json.post.id}`, { status: "closed" });

  const list = await call("alice", "GET", "/board");
  check("목록이 온다", list.status === 200 && Array.isArray(list.json.posts), String(list.status));
  check("상태로 거르지 않고 전부 준다 — 탭마다 건수를 세야 하므로", list.json.posts.length === 3, String(list.json?.posts?.length));
  check("열린 것과 닫힌 것이 함께 있다",
    list.json.posts.some((p: any) => p.status === "open") && list.json.posts.some((p: any) => p.status === "closed"));

  const times = list.json.posts.map((p: any) => p.createdAt);
  check("새것이 먼저 온다", [...times].sort().reverse().join() === times.join(), times.join(" / "));

  check("목록에는 본문이 실리지 않는다", list.json.posts.every((p: any) => p.body === undefined), JSON.stringify(list.json.posts[0]));
  check("대신 답변 수가 실린다", list.json.posts.find((p: any) => p.id === postId)?.replyCount === 1, String(list.json.posts.find((p: any) => p.id === postId)?.replyCount));
  check("목록에서도 관리 가능 여부가 사람마다 다르다",
    list.json.posts.find((p: any) => p.id === postId)?.canManage === true &&
    list.json.posts.find((p: any) => p.authorId === "bob")?.canManage === false);

  check("쓰이고 있는 태그가 함께 온다", list.json.tags.join() === "검색,pdf,색인".split(",").sort().join(), list.json?.tags?.join());

  const asAdmin = await call("admin", "GET", "/board");
  check("관리자에게는 전부 관리 가능으로 보인다", asAdmin.json.posts.every((p: any) => p.canManage === true));
}

/* --------------------------------------------------------------- 지우기 */

{
  const gone = await call("alice", "DELETE", `/board/${postId}`);
  check("쓴 사람은 지울 수 있다", gone.status === 204, String(gone.status));
  const after = await call("alice", "GET", `/board/${postId}`);
  check("지운 글은 404", after.status === 404 && after.json.code === "not_found", `${after.status} ${after.json?.code}`);
  const list = await call("alice", "GET", "/board");
  check("목록에서도 사라진다", list.json.posts.length === 2, String(list.json?.posts?.length));
  // 답변은 글 안에 있으므로 함께 사라진다 — 남겨 둘 곳이 없다.
  check("답변도 함께 사라진다", !JSON.stringify(list.json).includes("전처리 모듈이 붙기 전"));
}

/* ------------------------------------------------ 이상한 id 는 밖으로 못 나간다 */

{
  for (const bad of ["..%2F..%2Fetc", "%2Fetc%2Fpasswd", "post_%00"]) {
    const res = await call("alice", "GET", `/board/${bad}`);
    check(`경로를 벗어나려는 id 는 404: ${bad}`, res.status === 404, String(res.status));
  }
}

server.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
