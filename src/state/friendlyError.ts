/**
 * 답변 오류를 사람이 읽는 한 줄로 바꾼다. 원문(서버·브라우저가 준 그대로)은
 * 오류 카드의 '자세히' 안에 남기고, 카드 앞면에는 무엇을 하면 되는지만 쓴다.
 *
 * null 은 "오류가 아니다" — 사용자가 직접 멈춘 답은 카드를 그리지 않는다.
 */

const NETWORK = "연결이 끊겨 답변을 끝까지 받지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.";
const MODEL_SERVER = "모델 서버가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.";
const RATE_LIMITED = "요청이 많아 잠시 처리할 수 없습니다. 1분쯤 뒤 다시 시도해 주세요.";
const UNAUTHORIZED = "로그인이 만료되었습니다. 다시 로그인해 주세요.";
const GENERIC = "답변을 만들지 못했습니다.";

/**
 * 사용자의 중지 버튼으로 끝난 답. 오류가 아니다. "Cancelled by client." 는 서버가
 * 멈춘 답을 저장하던 문구다(server/chat/toolLoop.ts) — 지금은 stopped 로 저장하지만,
 * 그 전에 저장된 답은 이 문구를 error 로 들고 있다.
 */
const USER_STOP = /중지되었습니다|AbortError|aborted by user|aborted-by-user|The user aborted|Cancelled by client/i;

/** 이 오류 문구가 사용자가 멈춘 것인가. 멈춘 답은 실패 카드 대신 "중지됨" 으로 보인다. */
export function isUserStop(raw: string | undefined | null): boolean {
  return USER_STOP.test((raw ?? "").trim());
}

/** 브라우저 쪽 연결(src/api/client.ts 의 문구)과 각 브라우저의 fetch 실패 문구. */
const NETWORK_ERROR =
  /^서버에 연결할 수 없습니다|스트림을 읽는 중|스트리밍 응답 본문|Failed to fetch|NetworkError|Load failed|network error|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i;

/** 서버가 모델 서버(vLLM)에 닿지 못했을 때. */
const MODEL_SERVER_ERROR = /모델 서버|vLLM|ECONNREFUSED|fetch failed|Bad Gateway|Service Unavailable|Gateway Timeout/i;

/** 서버가 이미 사람에게 맞춰 쓴 안내(routes/conversations.ts readableTurnError). 그대로 보인다. */
const SERVER_GUIDANCE = /^메시지가 모델의 컨텍스트 한도를 넘습니다/;

/** 문장 속 HTTP 상태 번호. "8회" 같은 다른 숫자에 걸리지 않게 앞뒤가 숫자가 아닌 것만. */
function hasStatus(raw: string, status: number): boolean {
  return new RegExp(`(?:^|[^\\d.])${status}(?![\\d.])`).test(raw);
}

export function friendlyError(raw: string | undefined | null): string | null {
  const text = (raw ?? "").trim();
  if (text.length === 0) return null;
  if (isUserStop(text)) return null;
  if (SERVER_GUIDANCE.test(text)) return text;
  // 연결 문구가 먼저다: "서버에 연결할 수 없습니다: fetch failed" 는 모델 서버가 아니라
  // 이 브라우저와 웹 서버 사이가 끊긴 것이다.
  if (NETWORK_ERROR.test(text)) return NETWORK;
  if (hasStatus(text, 401)) return UNAUTHORIZED;
  if (hasStatus(text, 429)) return RATE_LIMITED;
  if (hasStatus(text, 502) || hasStatus(text, 503) || hasStatus(text, 504) || MODEL_SERVER_ERROR.test(text)) {
    return MODEL_SERVER;
  }
  return GENERIC;
}

/* ------------------------------------------------- 화면에 보일 오류 한 줄 */

/**
 * src/api/http.ts 가 서버 문장 뒤에 붙이는 상태 꼬리 — "… (404 Not Found)".
 * 세 자리 상태 번호로 시작하는 맨 끝 괄호만 본다. "(2건 실패)" 같은 다른 괄호는 건드리지 않는다.
 */
const STATUS_SUFFIX = /\s*\((\d{3})(?:\s[^()]*)?\)$/;

/** 서버가 문장을 주지 않았을 때의 문구(http.ts). 이때는 상태가 유일한 단서라 남긴다. */
const BARE_FAILURE = /^요청이 실패했습니다$/;

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 잡은 예외를 화면에 보일 한 줄로. Error 가 아닌 것이 던져져도 문자열로 바꾼다.
 *
 * "(404 Not Found)" 같은 HTTP 꼬리는 뗀다 — 서버가 이미 사람에게 쓴 문장 뒤에 붙은
 * 개발자용 표기라, 화면에서는 소음이다. 상태로 갈라야 하는 곳은 isNotFoundError 를 쓴다.
 */
export function errorMessage(error: unknown): string {
  const raw = rawMessage(error);
  const match = STATUS_SUFFIX.exec(raw);
  if (!match) return raw;
  const text = raw.slice(0, match.index);
  return text.trim() === "" || BARE_FAILURE.test(text.trim()) ? raw : text;
}

/** 찾는 것이 없다는 답(404·410)이었는가. 지워진 글·만료된 공유 링크처럼 '오류' 가 아니라 '없음' 인 경우. */
export function isNotFoundError(error: unknown): boolean {
  const status = STATUS_SUFFIX.exec(rawMessage(error))?.[1];
  return status === "404" || status === "410";
}
