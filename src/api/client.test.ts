// API 클라이언트의 401 처리 검사: 세션이 끊긴 401 은 어느 helper 를 거쳐도
// 로그인 화면으로 돌려보내고, 로그인 전 경로의 401 은 그대로 둔다.
// `npx tsx src/api/client.test.ts` 로 돈다.
import * as api from "./client";

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

let unauthorized = 0;
api.setUnauthorizedHandler(() => {
  unauthorized++;
});

function answer(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

async function bounces(name: string, work: () => Promise<unknown>, expected: boolean): Promise<void> {
  unauthorized = 0;
  try {
    await work();
  } catch {
    // 거절은 예외로 온다 — 여기서 보는 것은 처리기를 불렀는지다.
  }
  check(name, (unauthorized > 0) === expected, `handler calls: ${unauthorized}`);
}

console.log("src/api/client.ts");

answer(401, { error: "로그인이 필요합니다.", code: "unauthenticated" });
await bounces("관리 API 의 401 은 로그인 화면으로", () => api.listAdminUsers(), true);
await bounces("계정 상태 변경의 401 도", () => api.updateUserStatus("u1", "approve"), true);
await bounces("비밀번호 변경의 401 도", () => api.changePassword("a", "b"), true);
await bounces("모델 서버 추가의 401 도", () => api.addModelEndpoint({ baseUrl: "http://x" }, ""), true);
await bounces("모델 서버 제거의 401 도", () => api.deleteModelEndpoint("http://x", ""), true);
await bounces("로그인의 401 은 틀린 비밀번호일 뿐", () => api.login("id", "pw"), false);
await bounces("내 계정 확인의 401 은 로그인 전일 뿐", () => api.getMe(), false);
await bounces("가입의 401 도 그대로", () => api.signup({ id: "a", password: "b", name: "c", email: "d@e.f" } as never), false);
await bounces("로그아웃의 401 도 그대로", () => api.logout(), false);
await bounces("일반 요청의 401 은 원래대로", () => api.listConversations(), true);

answer(403, { error: "현재 비밀번호가 맞지 않습니다.", code: "wrong_password" });
await bounces("비밀번호 변경의 403 은 돌려보내지 않는다", () => api.changePassword("a", "b"), false);

// 오류 본문 해석은 helper 마다 문구가 그대로여야 한다(friendlyError 정규식이 이 문구를 본다).
answer(500, { error: "망가짐" });
try {
  await api.listConversations();
} catch (error) {
  check("request 의 오류 문구", (error as Error).message === "망가짐 (500)", (error as Error).message);
}
try {
  await api.listAdminUsers();
} catch (error) {
  check("authRequest 의 오류 문구", (error as Error).message === "망가짐", (error as Error).message);
}
globalThis.fetch = (async () => new Response("not json", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
try {
  await api.listConversations();
} catch (error) {
  check("JSON 이 아니면 상태 줄", (error as Error).message === "요청이 실패했습니다 (502 Bad Gateway)", (error as Error).message);
}
try {
  await api.deleteMcpServer("x");
} catch (error) {
  const mcp = error as api.McpError;
  check("mcpRequest 의 상태 줄", mcp.message === "요청이 실패했습니다 (502)" && mcp.status === 502, mcp.message);
}
answer(409, { error: "다른 사람이 쓰고 있습니다", adoptedCount: 3 });
try {
  await api.deleteMcpServer("x");
} catch (error) {
  check("mcpRequest 의 adoptedCount", (error as api.McpError).adoptedCount === 3);
}

// 문서 업로드의 진행 스트림은 대화 스트림과 같은 SSE 파서를 탄다.
{
  const frames = ['data: {"type":"stage","stage":"extract","message":"글자 꺼내는 중"}\r\n\r\nda', 'ta: {"type":"done","documents":[{"id":"d1"}]}'];
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as typeof fetch;
  const seen: string[] = [];
  const documents = await api.uploadDocument("a.txt", new Blob(["x"]), "private", (event) => seen.push(event.type));
  check("업로드 진행: 조각난 이벤트·CRLF·끝 빈 줄 없음", seen.join(",") === "stage,done" && documents[0]?.id === "d1", seen.join(","));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
