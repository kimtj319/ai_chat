/**
 * "지금 답변하기" 버튼을 띄울지 정하는 순수 함수.
 *
 * 조건은 넷이다 — 스트리밍 중이고, 이 턴이 시작된 지 answerNowAfterMs 이상
 * 지났고, 이번 턴에서 아직 누르지 않았고, 지금 답변 글자가 흘러나오는 중이
 * 아닐 때. 기준 시각은 서버가 turn_started
 * 이벤트로 보낸 startedAt(useChatStream.ts)이다 — 클라이언트 자신의
 * Date.now() 를 기준으로 삼으면 요청이 늦게 도착했을 때나 클라이언트 시계가
 * 서버와 어긋났을 때 3분 표시가 실제 대기 시간과 어긋난다.
 *
 * DOM 도, 타이머도, `Date.now()` 호출도 없다 — "지금"까지 인자로 받아서 검사가
 * 실제 시계에 기대지 않게 한다.
 */
export interface AnswerNowVisibilityInput {
  isStreaming: boolean;
  /** turn_started 이벤트가 아직 도착하지 않았으면 null — 기준이 없으니 버튼도 없다. */
  turnStartedAt: number | null;
  answerNowAfterMs: number;
  /** 이번 턴에서 이미 눌렀는지. 누른 뒤에는 다시 뜨지 않는다. */
  clicked: boolean;
  /**
   * 지금 최종 답변 글자가 흘러나오는 중인지. 그렇다면 버튼은 없다 — 사용자는
   * "기다려서 답변이 출력되면 버튼이 없어져야 한다" 고 했고, 답이 나오는 도중에
   * 누르면 마무리 답변이 이미 나온 조각 뒤에 이어 붙어 두 조각이 된다.
   * 도구를 다시 부르러 가면 거짓으로 돌아와 버튼이 되살아난다.
   */
  answerStreaming: boolean;
  now: number;
}

export function shouldShowAnswerNowButton(input: AnswerNowVisibilityInput): boolean {
  if (!input.isStreaming || input.clicked || input.answerStreaming || input.turnStartedAt === null) return false;
  return input.now - input.turnStartedAt >= input.answerNowAfterMs;
}
