// 설정 검증 검사. `npm test` 로 돈다.
//
// 지키는 것은 둘이다: **설정하지 않은 값은 문제가 아니다**(기본값을 쓰겠다는
// 뜻이므로), 그리고 **설정했는데 살아남지 못하는 값은 문제다**(운영자가 정한
// 값이 아무 데도 없는 채로 서비스가 뜨기 때문). 앞을 어기면 아무것도 못 띄우고,
// 뒤를 어기면 예전처럼 조용히 기본값으로 돈다.
//
// 파서 쪽 검사(검사는 통과했는데 값이 먹지 않는 경우)는 config 를 불러들일 때의
// 환경을 보므로, 그 값들을 import 보다 먼저 세운다.
process.env.COOKIE_SECURE = "on";
process.env.FEEDBACK_DETECT = "off";
process.env.CONTEXT_COMPACT_RATIO = "0";
const { assertConfigValid, config, inspectConfig } = await import("./config.js");

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

const errs = (env: NodeJS.ProcessEnv) => inspectConfig(env).errors.map((e) => e.key);
const warns = (env: NodeJS.ProcessEnv) => inspectConfig(env).warnings.map((e) => e.key);

console.log("server/config.ts — inspectConfig");

/* ------------------------------------------------- 설정하지 않은 것은 문제가 아니다 */

{
  check("빈 환경은 통과한다", errs({}).length === 0, JSON.stringify(errs({})));
  check("빈 문자열은 '설정하지 않음'으로 본다", errs({ PORT: "", RAG_ENGINE_URL: "  " }).length === 0);
}

/* ------------------------------------------------------------ 오타난 값은 막는다 */

{
  check("숫자 자리에 글자", errs({ RAG_DOC_MAX_BYTES: "abc" }).includes("RAG_DOC_MAX_BYTES"));
  check("포트 범위 밖", errs({ PORT: "99999" }).includes("PORT"));
  check("포트 0", errs({ PORT: "0" }).includes("PORT"));
  check("비율이 1 을 넘음", errs({ CONTEXT_COMPACT_RATIO: "1.5" }).includes("CONTEXT_COMPACT_RATIO"));
  check("비율이 0", errs({ CONTEXT_KEEP_RECENT_RATIO: "0" }).includes("CONTEXT_KEEP_RECENT_RATIO"));
  check("불리언 자리에 아무 말", errs({ COOKIE_SECURE: "아마도" }).includes("COOKIE_SECURE"));
  check("주소가 아닌 주소", errs({ RAG_ENGINE_URL: "localhost:9400" }).includes("RAG_ENGINE_URL"));
  check("http/https 가 아닌 주소", errs({ TAVILY_API_URL: "ftp://x/y" }).includes("TAVILY_API_URL"));
}
{
  // 파서가 1초 미만을 기본값으로 되돌린다 — 값이 살아남지 못하므로 알려야 한다.
  check("1초 미만 타임아웃은 무시되므로 막는다", errs({ TOOL_TIMEOUT_MS: "200" }).includes("TOOL_TIMEOUT_MS"));
  check("충분히 큰 타임아웃은 통과", !errs({ TOOL_TIMEOUT_MS: "10000" }).includes("TOOL_TIMEOUT_MS"));
}

/* ------------------------------------------------------------ 멀쩡한 값은 통과 */

{
  const ok: NodeJS.ProcessEnv = {
    PORT: "9000",
    DATA_DIR: "./data",
    COOKIE_SECURE: "false",
    CONTEXT_COMPACT_RATIO: "0.8",
    RAG_ENGINE_URL: "http://localhost:9400",
    RAG_DOC_MAX_BYTES: "524288",
    TOOL_TIMEOUT_MS: "10000",
    MCP_DEBUG_TOOLS_HASH: "0",
  };
  check("실제 운영값 묶음은 통과한다", errs(ok).length === 0, JSON.stringify(inspectConfig(ok).errors));
}

/* ------------------------------------------------ 검사를 통과한 값은 실제로 먹는다 */

{
  // .env.example 이 "0 이면 압축을 끈다" 고 적고 파서도 0 을 받는데, 검사가 막으면
  // 문서대로 적은 운영자의 서버가 뜨지 않는다.
  check("압축 비율 0 은 '끄기' 라 통과", !errs({ CONTEXT_COMPACT_RATIO: "0" }).includes("CONTEXT_COMPACT_RATIO"));
  check("압축 비율이 음수면 막는다", errs({ CONTEXT_COMPACT_RATIO: "-0.1" }).includes("CONTEXT_COMPACT_RATIO"));
  check("압축 비율 0 은 정말 0 이 된다", config.contextCompactRatio === 0, String(config.contextCompactRatio));
  // 검사는 on/off 를 받는데 파서가 on 을 모르면, 통과한 설정이 아무 일도 안 한다.
  check("COOKIE_SECURE=on 은 Secure 를 켠다", config.cookieSecure === true, String(config.cookieSecure));
  check("FEEDBACK_DETECT=off 는 끈다", config.feedbackDetect === false, String(config.feedbackDetect));
}
{
  // 파서가 읽는데 검사 목록에 없던 키들 — 오타가 조용히 기본값이 되던 자리다.
  check("CONTEXT_TOOL_STOP_RATIO 도 본다", errs({ CONTEXT_TOOL_STOP_RATIO: "2" }).includes("CONTEXT_TOOL_STOP_RATIO"));
  check(
    "CONTEXT_HISTORY_SUMMARY_RATIO 도 본다",
    errs({ CONTEXT_HISTORY_SUMMARY_RATIO: "x" }).includes("CONTEXT_HISTORY_SUMMARY_RATIO"),
  );
  check(
    "ATTACHMENT_MESSAGE_TOKEN_RATIO 도 본다",
    errs({ ATTACHMENT_MESSAGE_TOKEN_RATIO: "0" }).includes("ATTACHMENT_MESSAGE_TOKEN_RATIO"),
  );
  for (const key of [
    "ATTACHMENT_INLINE_TEXT_BYTES",
    "ATTACHMENT_MAX_MESSAGE_BYTES",
    "ATTACHMENT_DEFAULT_MESSAGE_TOKENS",
    "ATTACHMENT_MAX_PER_CONVERSATION",
    "ATTACHMENT_MAX_CONVERSATION_BYTES",
    "ATTACHMENT_MAX_SESSION_BYTES",
    "ATTACHMENT_MIN_FREE_DISK_BYTES",
  ]) {
    check(`${key} 도 본다`, errs({ [key]: "abc" }).includes(key));
  }
  check("MODEL_CAPABILITY_PROBE 도 본다", errs({ MODEL_CAPABILITY_PROBE: "아마" }).includes("MODEL_CAPABILITY_PROBE"));
  check("FEEDBACK_DETECT 도 본다", errs({ FEEDBACK_DETECT: "아마" }).includes("FEEDBACK_DETECT"));
}

/* --------------------------------------------------------- 반쪽짜리 설정은 막는다 */

{
  const half = { GITLAB_MCP_URL: "http://1.2.3.4:8792/mcp", MCP_ALLOW_HTTP_HOSTS: "1.2.3.4" };
  check("주소만 있고 토큰이 없으면 막는다", errs(half).includes("GITLAB_TOKEN"), JSON.stringify(errs(half)));
  const both = { ...half, GITLAB_TOKEN: "t" };
  check("둘 다 있으면 통과", !errs(both).includes("GITLAB_TOKEN"), JSON.stringify(errs(both)));
  const reversed = { GITLAB_TOKEN: "t" };
  check("토큰만 있어도 막는다", errs(reversed).includes("GITLAB_MCP_URL"));
}
{
  check("청킹 모델 주소만 있으면 막는다", errs({ RAG_CHUNK_MODEL_URL: "http://a/b" }).includes("RAG_CHUNK_MODEL"));
  // 막지는 않는다: 계정을 만든 뒤 비밀번호를 .env 에서 빼는 것이 옳은 운영이고,
  // 그걸 오류로 보면 잘 돌던 서버가 재기동에서 멈춘다.
  check("관리자 아이디만 있어도 막지는 않는다", !errs({ ADMIN_ID: "kim" }).includes("ADMIN_PASSWORD"));
  check("대신 알려는 준다", warns({ ADMIN_ID: "kim" }).includes("ADMIN_PASSWORD"));
  check("비밀번호만 있어도 알려 준다", warns({ ADMIN_PASSWORD: "x" }).includes("ADMIN_ID"));
  check("둘 다 있으면 조용하다", warns({ ADMIN_ID: "kim", ADMIN_PASSWORD: "x" }).length === 0);
}

/* ------------------------------------------- http MCP 인데 허용 목록에 없으면 막는다 */

{
  const missing = { RAG_MCP_URL: "http://10.0.0.1:8791/mcp", MCP_IDENTITY_TOKEN: "x" };
  check(
    "http MCP 가 허용 목록에 없으면 막는다",
    errs(missing).includes("MCP_ALLOW_HTTP_HOSTS"),
    JSON.stringify(inspectConfig(missing).errors),
  );
  const allowed = { ...missing, MCP_ALLOW_HTTP_HOSTS: "10.0.0.1" };
  check("허용 목록에 있으면 통과", !errs(allowed).includes("MCP_ALLOW_HTTP_HOSTS"), JSON.stringify(errs(allowed)));
  const https = { RAG_MCP_URL: "https://mcp.example.com/mcp", MCP_IDENTITY_TOKEN: "x" };
  check("https 는 허용 목록이 필요 없다", errs(https).length === 0, JSON.stringify(errs(https)));
}

/* ------------------------------------------------------ 막지는 않지만 알려 주는 것 */

{
  const noIdentity = { RAG_MCP_URL: "https://m/x" };
  check("신원 토큰이 없으면 주의를 준다", warns(noIdentity).includes("MCP_IDENTITY_TOKEN"));
  check("그래도 기동은 막지 않는다", errs(noIdentity).length === 0, JSON.stringify(errs(noIdentity)));
}

/* -------------------------------------------------------------- 던지는 쪽 */

{
  let threw = "";
  try {
    assertConfigValid({ PORT: "abc", RAG_DOC_MAX_BYTES: "xyz" });
  } catch (err) {
    threw = (err as Error).message;
  }
  check("문제가 있으면 던진다", threw.length > 0);
  check("한 번에 전부 보여 준다", threw.includes("PORT") && threw.includes("RAG_DOC_MAX_BYTES"), threw);
  check("몇 건인지 말해 준다", threw.includes("2건"), threw);

  let ok = true;
  try {
    assertConfigValid({ PORT: "9000" });
  } catch {
    ok = false;
  }
  check("문제가 없으면 던지지 않는다", ok);
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
