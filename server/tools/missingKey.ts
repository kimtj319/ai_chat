/**
 * The refusal a tool gives when the caller has no API key to use it with
 * (auth/privilege.ts: accounts outside the shared-key groups need their own).
 *
 * One marker in the message, so chat/toolLoop.ts can tell this refusal from any
 * other tool error and show the person a notice of its own — the model's
 * paraphrase of a tool error is not something to rely on.
 */
export const MISSING_KEY_MARK = "[API 키 미등록]";

export function missingKeyMessage(service: string, howToGet: string): string {
  return (
    `${MISSING_KEY_MARK} ${service} API 키가 등록되어 있지 않아 이 도구를 사용할 수 없습니다. ` +
    `설정 › 개인 키 (API 키·토큰)에서 본인 키를 등록하세요(${howToGet}). ` +
    "Tell the user this in Korean; do not retry."
  );
}

export function isMissingKeyError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes(MISSING_KEY_MARK);
}
