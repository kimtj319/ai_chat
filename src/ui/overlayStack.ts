/**
 * 지금 화면 위에 무엇이 떠 있는가.
 *
 * Esc 는 이 앱에서 두 가지 뜻을 갖는다: 떠 있는 것을 닫기, 그리고 생성 멈추기.
 * 둘 다 window 의 keydown 을 듣는데, window 리스너끼리는 서로를 막을 수 없다.
 * 그래서 **답변을 기다리다 모달을 Esc 로 닫으면 답변까지 끊겼다** — 하필
 * 기다리는 중일 때만 물리는, 알아채기 어려운 종류의 고장이다.
 *
 * 고치는 방법은 순서를 다투는 것이 아니라 사실을 하나 공유하는 것이다:
 * 떠 있는 것이 하나라도 있으면 Esc 는 그것의 몫이고, 생성 중단은 떠 있는 것이
 * 없을 때만 한다. 겹겹이 쌓일 수 있으므로(모달 위의 확인 대화상자) 세어 둔다.
 *
 * 모듈 하나에 숫자 하나다. 화면 밖의 상태이고 React 가 다시 그릴 일이 없으므로
 * context 로 만들 이유가 없다.
 */

let depth = 0;

/** 떠올랐다고 알린다. 돌려받은 함수를 내려갈 때 부른다. */
export function pushOverlay(): () => void {
  depth += 1;
  let released = false;
  return () => {
    // 같은 해제 함수를 두 번 불러도 셈이 어긋나지 않게 한다. React 18 의
    // StrictMode 는 effect 를 일부러 두 번 돌린다.
    if (released) return;
    released = true;
    depth -= 1;
  };
}

export function overlayOpen(): boolean {
  return depth > 0;
}

/** 검사용. 앞선 검사가 남긴 셈이 다음 검사로 새지 않게 한다. */
export function resetOverlayStack(): void {
  depth = 0;
}
