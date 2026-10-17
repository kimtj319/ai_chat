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

/** 사용자의 중지 버튼으로 끝난 답. 오류가 아니다. */
const USER_STOP = /중지되었습니다|AbortError|aborted by user|aborted-by-user|The user aborted/i;

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
  if (USER_STOP.test(text)) return null;
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
