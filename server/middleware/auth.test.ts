// 권한 경계 검사. `npm test` 로 돈다.
//
// 이 저장소에서 검사가 가장 먼저 필요한 자리다. 여기가 틀리면 남의 대화가
// 보이거나, 승인되지 않은 계정이 들어오거나, 관리자 기능이 열린다 — 그리고
// 셋 다 **조용히** 틀린다. 다른 곳과 달리 화면에 오류가 나지 않는다.
//
// 확인하려는 것:
//   1. 로그인 없이 열려 있어야 하는 경로는 **정확히 그 다섯 개**뿐이다
//   2. 로그인하지 않으면 401, 차단·승인대기는 403 이고 서로 다른 코드를 준다
//   3. 관리자 기능은 role 로만 열린다
import { isPublicApiPath, requireActiveUser, requireAdmin } from "./auth.js";
import type { Request, Response } from "express";
import type { UserRecord } from "../types.js";

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

/** 미들웨어 하나를 돌려 보고, 통과했는지·무엇으로 막았는지 돌려준다. */
function run(
  middleware: (req: Request, res: Response, next: () => void) => void,
  user: Partial<UserRecord> | null,
  // requireActiveUser 는 공개 경로를 먼저 보고 통과시킨다. 기본값은 닫힌 경로라
  // "막히는가" 를 묻는 검사가 공개 경로 덕에 통과하는 일이 없다.
  path = "/conversations",
): { passedThrough: boolean; status: number | null; code: string | null } {
  let passedThrough = false;
  let status: number | null = null;
  let body: { code?: string } | null = null;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: { code?: string }) {
      body = b;
      return this;
    },
  } as unknown as Response;
  const req = { user: user ?? undefined, path } as unknown as Request;
  middleware(req, res, () => {
    passedThrough = true;
  });
  return { passedThrough, status, code: body?.code ?? null };
}

const account = (over: Partial<UserRecord> = {}): Partial<UserRecord> => ({
  id: "u1",
  role: "user",
  status: "active",
  ...over,
});

console.log("server/middleware/auth.ts");

/* ------------------------------------------------ 1. 로그인 없이 열린 경로 */

{
  // 이 다섯 개**만** 열려 있어야 한다. 하나가 더 열리면 그 경로로 로그인 없이
  // 서버를 만질 수 있고, 목록이 눈에 안 보이는 곳에 있어 알아채기 어렵다.
  const open = ["/auth/signup", "/auth/login", "/auth/logout", "/auth/me", "/health"];
  for (const p of open) check(`열려 있어야 한다: ${p}`, isPublicApiPath(p));

  const closed = [
    "/conversations",
    "/documents",
    "/mcp/servers",
    "/admin/users",
    "/models/endpoints",
    "/tools",
    "/session",
    "/auth", // 접두사만 같은 것
    "/auth/login/extra",
    "/healthz",
    "",
    "/",
  ];
  for (const p of closed) check(`닫혀 있어야 한다: ${p || "(빈 경로)"}`, !isPublicApiPath(p));
}
{
  check("끝의 빗금은 무시한다", isPublicApiPath("/auth/login/") && isPublicApiPath("/health//"));
  // 대소문자를 섞어 우회하지 못해야 한다.
  check("대소문자는 다른 경로다", !isPublicApiPath("/Auth/Login"));
}

/* ------------------------------------------------------ 2. 로그인 상태 검사 */

{
  const r = run(requireActiveUser, null);
  check("로그인하지 않으면 막는다", !r.passedThrough);
  check("그때는 401 이다", r.status === 401, String(r.status));
  check("코드는 unauthorized", r.code === "unauthorized", String(r.code));
}
{
  const r = run(requireActiveUser, account({ status: "blocked" }));
  check("차단된 계정은 막는다", !r.passedThrough);
  check("그때는 403 이다", r.status === 403, String(r.status));
  check("코드는 blocked", r.code === "blocked", String(r.code));
}
{
  const r = run(requireActiveUser, account({ status: "pending" }));
  check("승인 대기 계정은 막는다", !r.passedThrough);
  check("코드는 pending_approval", r.code === "pending_approval", String(r.code));
  // 차단과 승인대기를 같은 코드로 주면 화면이 잘못된 안내를 하게 된다.
  check("차단과 다른 코드를 준다", r.code !== "blocked");
}
{
  const r = run(requireActiveUser, account());
  check("정상 계정은 통과한다", r.passedThrough && r.status === null);
}
{
  // 공개 경로는 로그인 없이도 지나가야 한다 — 안 그러면 로그인 화면 자체가 막힌다.
  const r = run(requireActiveUser, null, "/auth/login");
  check("공개 경로는 로그인 없이 지나간다", r.passedThrough, `${r.status}/${r.code}`);
  const blocked = run(requireActiveUser, account({ status: "blocked" }), "/auth/logout");
  check("차단된 계정도 로그아웃은 할 수 있다", blocked.passedThrough, `${blocked.status}/${blocked.code}`);
}

/* ---------------------------------------------------------- 3. 관리자 검사 */

{
  const r = run(requireAdmin, account({ role: "admin" }));
  check("관리자는 통과한다", r.passedThrough);
}
for (const [label, user] of [
  ["일반 사용자", account({ role: "user" })],
  ["로그인하지 않음", null],
] as const) {
  const r = run(requireAdmin, user);
  check(`관리자가 아니면 막는다: ${label}`, !r.passedThrough);
  check(`그때는 403/not_admin: ${label}`, r.status === 403 && r.code === "not_admin", `${r.status}/${r.code}`);
}
{
  // role 문자열을 흉내 내도 통하지 않아야 한다.
  for (const role of ["Admin", "ADMIN", "administrator", "superuser", ""] as const) {
    const r = run(requireAdmin, account({ role: role as UserRecord["role"] }));
    check(`role="${role}" 은 관리자가 아니다`, !r.passedThrough);
  }
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
