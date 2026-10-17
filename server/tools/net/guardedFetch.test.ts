// 가져오기 관문 검사. `npm test` 로 돈다.
//
// 여기서 지키는 것은 하나다: **닿지 못하는 곳은 시도하기 전에 거절하고, 대신
// 쓸 것을 알려 준다.** 거절이 너무 넓으면 멀쩡한 주소를 못 읽고, 너무 좁으면
// 모델이 10초씩 기다렸다가 아무것도 못 얻는다.
//
// config 는 불러들일 때 환경변수를 읽으므로, import 보다 먼저 세워 둔다.
process.env.GITLAB_URL = "https://gitlab.example.com";
process.env.TOOL_FETCH_ALLOWLIST = "";

const { assertFetchableUrl, GITLAB_REDIRECT } = await import("./guardedFetch.js");
const { isPublicIp } = await import("./ssrf.js");

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

/** 거절당했으면 그 메시지를, 통과했으면 null 을 준다. */
async function refusal(url: string): Promise<string | null> {
  try {
    await assertFetchableUrl(new URL(url));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("server/tools/net/guardedFetch.ts");

/* ------------------------------------------------------------- GitLab 은 거절 */

for (const url of [
  "https://gitlab.example.com/api/v4/users?username=someone",
  "https://gitlab.example.com/someone",
  "https://gitlab.example.com/issue/sf-1-v7-issue/-/work_items/1506",
  "http://gitlab.example.com/",
  "https://gitlab.example.com/api/v4/version",
]) {
  const msg = await refusal(url);
  check(`거절한다: ${url.slice(0, 56)}`, msg === GITLAB_REDIRECT, String(msg));
}

{
  // 거절만 하면 모델은 다음에 무엇을 해야 할지 모른다.
  check("메시지가 쓸 도구를 이름으로 말해 준다", GITLAB_REDIRECT.includes("mcp__gitlab__gitlab_issues"), GITLAB_REDIRECT);
  check("본문·댓글·라벨 도구도 함께 말해 준다",
    GITLAB_REDIRECT.includes("gitlab_issue_notes") && GITLAB_REDIRECT.includes("gitlab_labels"));
  check("왜 안 되는지도 말해 준다", GITLAB_REDIRECT.includes("인증서"));
}

/* --------------------------------------------------- 다른 곳은 그대로 둔다 */

{
  // 이름이 비슷하다고 막으면 안 된다 — 막는 것은 그 호스트 하나다.
  for (const url of ["https://gitlab.com/x", "https://docs.gitlab.example.com.example.com/"]) {
    const msg = await refusal(url);
    check(`다른 호스트는 이 규칙에 걸리지 않는다: ${new URL(url).hostname}`, msg !== GITLAB_REDIRECT, String(msg));
  }
}
{
  const msg = await refusal("ftp://gitlab.example.com/x");
  check("프로토콜 거절이 먼저다", msg?.includes("Blocked protocol") === true, String(msg));
}
{
  // 기존 보호가 살아 있는지. 루프백은 여전히 막혀야 한다.
  const msg = await refusal("http://127.0.0.1:9000/");
  check("루프백은 여전히 막힌다", msg !== null && msg !== GITLAB_REDIRECT, String(msg));
}

/* ------------------------------------- IPv6 로 감싼 내부 주소도 막는다 */

{
  // URL 파서는 [::ffff:127.0.0.1] 을 ::ffff:7f00:1 로 바꿔 적는다. 점 표기만
  // 풀던 예전 검사는 이걸 공인 주소로 보고 루프백에 닿게 해 주었다.
  for (const url of ["http://[::ffff:127.0.0.1]:9000/", "http://[::ffff:10.0.0.1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::127.0.0.1]/"]) {
    const msg = await refusal(url);
    check(`감싼 내부 주소는 막힌다: ${url}`, msg !== null && msg.includes("non-public"), String(msg));
  }
  for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::7f00:1", "64:ff9b::7f00:1", "224.0.0.1", "240.0.0.1",
    "198.18.0.1", "192.0.0.8", "::1", "::", "fe80::1", "fd00::1", "127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254"]) {
    check(`공인 주소가 아니다: ${ip}`, !isPublicIp(ip));
  }
  // 막는 범위가 너무 넓어지면 멀쩡한 곳을 못 읽는다.
  for (const ip of ["8.8.8.8", "1.1.1.1", "::ffff:808:808", "2001:4860:4860::8888", "198.20.0.1", "223.255.255.255"]) {
    check(`공인 주소다: ${ip}`, isPublicIp(ip));
  }
  check("주소가 아니면 막는다", !isPublicIp("not-an-ip"));
}

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
