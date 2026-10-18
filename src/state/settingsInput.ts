import { DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "./defaults";

export type MaxTokensInput = { ok: true; value: number } | { ok: false; message: string };

/**
 * 대화 설정의 Max Tokens 칸에 적힌 글자를 읽는다.
 *
 * 칸에는 글자를 그대로 두고 여기서만 숫자로 바꾼다. 예전에는 칠 때마다 Number() 로 바꿔
 * 상태에 넣었는데, 칸을 비우면 0 이 들어가 적용을 누른 뒤에야 서버에서 실패했다.
 * 비운 칸은 Seed 처럼 "기본값" 으로 읽는다.
 */
export function parseMaxTokens(raw: string): MaxTokensInput {
  const text = raw.trim();
  if (text === "") return { ok: true, value: DEFAULT_MAX_TOKENS };
  const range = `${MIN_MAX_TOKENS.toLocaleString()}–${MAX_MAX_TOKENS.toLocaleString()}`;
  // "1e3"·"2048.5" 같은 것은 숫자이긴 해도 토큰 수가 아니다. 자연수 글자만 받는다.
  if (!/^\d+$/.test(text)) return { ok: false, message: `${range} 사이의 정수를 입력해 주세요.` };
  const value = Number(text);
  if (value < MIN_MAX_TOKENS || value > MAX_MAX_TOKENS) {
    return { ok: false, message: `${range} 사이로 입력해 주세요.` };
  }
  return { ok: true, value };
}
