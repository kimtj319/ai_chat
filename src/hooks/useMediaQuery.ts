import { useEffect, useState } from "react";

/**
 * CSS 의 미디어쿼리를 그대로 물어본다.
 *
 * 폭에 따라 **레이아웃이 아니라 구조가** 달라지는 곳에만 쓴다. 사이드바가
 * 좁은 화면에서 드로어가 되는 것이 그렇다 — 붙박이 칸과 떠 있는 서랍은 CSS
 * 로 서로를 흉내 낼 수 없고, 스크림과 Esc 처리도 딸려 온다.
 *
 * 색·여백·숨김처럼 CSS 로 끝나는 것에는 쓰지 않는다. 기준점이 두 곳(여기와
 * 스타일시트)에 생기면 한쪽만 고쳤을 때 어긋난다.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    // 구독을 거는 사이에 창 크기가 바뀌었을 수 있다. 지금 값을 한 번 맞춘다.
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
