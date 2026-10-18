/**
 * 화면을 옮기기 전에 물어볼 것이 있는 화면이 여기에 확인을 걸어 둔다.
 *
 * 지금은 대화 설정 하나다: 고친 값이 "적용" 을 눌러야 들어가는 화면이라, 적용하지 않고
 * 사이드바의 다른 화면을 누르면 고친 것이 말없이 사라졌다. App 의 navigate 가 주소를
 * 바꾸기 전에 leaveVia 를 지나고, 걸린 확인이 있으면 그쪽이 묻고 나서 proceed 를 부른다.
 *
 * 하나만 둔다 — 떠날지 묻는 화면이 동시에 둘 떠 있을 일이 없다.
 */
type LeaveGuard = (proceed: () => void) => void;

let guard: LeaveGuard | null = null;

/** 확인을 건다(null 이면 걷는다). 돌려받은 함수는 자기가 건 것일 때만 걷는다. */
export function setLeaveGuard(next: LeaveGuard | null): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

/** 떠난다. 걸린 확인이 있으면 그것이 proceed 를 부를 때까지 기다린다. */
export function leaveVia(proceed: () => void): void {
  if (guard) guard(proceed);
  else proceed();
}
