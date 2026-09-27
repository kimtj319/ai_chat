/**
 * 이 앱이 놓인 자리(루트 경로)를 기준으로 주소를 만든다.
 *
 * 주소를 "/api/…" 처럼 도메인 루트에서 시작하게 쓰면, 앱이 다른 도메인의 하위 경로로
 * 연결되었을 때(예: 프록시가 https://ai.example.com/qwen/ 을 이 서버로 넘길 때)
 * 요청이 그 도메인의 루트로 가서 깨진다 — 관리 페이지·첨부 다운로드·출처 창이 그랬다.
 *
 * 그래서 기준을 "번들이 실제로 불려 온 곳" 에서 잰다. 빌드된 자바스크립트는 모두
 * `<앱 루트>/assets/` 아래에 있으므로 그 한 칸 위가 앱 루트다. 도메인도 하위 경로도
 * 코드에 적혀 있지 않다. 개발 서버(vite)는 모듈을 /src/… 에서 내주므로 그때는
 * 페이지 위치를 쓴다.
 */
let root: string | null = null;

function appRoot(): string {
  if (root !== null) return root;
  if (typeof window === "undefined") {
    // Node 에서 도는 검사(npm test). 브라우저가 아니니 루트 배치로 본다.
    root = "/";
  } else if (import.meta.env?.DEV) {
    root = new URL("./", window.location.href).pathname;
  } else {
    root = new URL("../", import.meta.url).pathname;
  }
  return root;
}

/** 앱 루트 기준 경로. `appPath("api/x")` → "/qwen/api/x" (루트에 놓였으면 "/api/x"). */
export function appPath(path: string): string {
  return `${appRoot()}${path.replace(/^\/+/, "")}`;
}

/** API 경로. `apiPath("/conversations")` → "<앱 루트>api/conversations". */
export function apiPath(path: string): string {
  return appPath(`api/${path.replace(/^\/+/, "")}`);
}
