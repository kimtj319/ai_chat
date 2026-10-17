import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ClientChatMessage } from "../state/types";

/** How close to the end still counts as "at the bottom".
 *  Wide enough that a chunk landing between the follow scroll and the scroll
 *  event it fires cannot read as the user having moved: a chunk is one token,
 *  which is a line of text at the very most. */
const BOTTOM_THRESHOLD_PX = 64;

/**
 * Keeps the transcript pinned to the end of a streaming answer until the user
 * scrolls away, and says when to offer the jump-to-bottom button.
 */
export function useFollowBottom(
  listRef: RefObject<HTMLDivElement | null>,
  conversationId: string,
  messages: ClientChatMessage[] | undefined,
): { showJumpToBottom: boolean; scrollToBottom: () => void } {
  // Whether the transcript is still chasing the end of the answer. A ref, not
  // state: the scroll listener writes it on every scroll event and the append
  // effect reads it on every streamed chunk, and neither wants a render. The
  // jump button is the only thing on screen that changes with it, so that gets
  // the one piece of state.
  const followBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // 조각이 몇 개 붙든 따라 내리기는 한 프레임에 한 번. 잡혀 있는 동안의 번호를 둔다.
  const followFrameRef = useRef<number | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    followBottomRef.current = true;
    setShowJumpToBottom(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  // Keyed on the conversation because ChatView's first render has no
  // conversation yet and so no list to listen to; the node arrives later.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // A programmatic scroll fires the same `scroll` event as a user's, so this
    // does not try to tell the two apart — it asks the live DOM where the view
    // sits now, and the threshold above is what makes our own scroll (which
    // lands at the end) re-arm rather than disarm.
    // 따라 내리기를 프레임마다 한 번으로 합쳤으므로, 새 조각이 붙은 뒤 그 프레임이 돌기
    // 전에 이전 스크롤의 이벤트가 늦게 올 수 있다. 그때는 끝에서 멀어 보여도 사용자가
    // 떠난 것이 아니다 — 위로 움직인 것이 아니고 프레임이 잡혀 있으면 따라가기를 둔다.
    // 위로 움직였어도 거리가 0 이면 본문이 줄어 브라우저가 scrollTop 을 당긴 것이다.
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const movedUp = el.scrollTop < lastTop;
      lastTop = el.scrollTop;
      if (movedUp && distance > 1) followBottomRef.current = false;
      else if (distance <= BOTTOM_THRESHOLD_PX) followBottomRef.current = true;
      else if (followFrameRef.current === null) followBottomRef.current = false;
      setShowJumpToBottom(distance > BOTTOM_THRESHOLD_PX && !followBottomRef.current);
    };

    // 휠·손가락으로 위로 가려는 순간 바로 놓는다. scroll 이벤트를 기다리면 그 사이 잡혀
    // 있던 프레임이 화면을 다시 끝으로 끌어내려 사용자와 줄다리기를 한다.
    // 위로 갈 데가 없으면(scrollTop 0) 아무것도 놓지 않는다.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && el.scrollTop > 0) followBottomRef.current = false;
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      // 손가락이 아래로 = 본문이 위로.
      if (touchY !== null && y > touchY && el.scrollTop > 0) followBottomRef.current = false;
      touchY = y;
    };

    // 목록 칸이 줄어들 때(폰 키보드가 올라오거나 입력창이 여러 줄로 커질 때)는 scroll
    // 이벤트도 메시지 변화도 없어 끝에 있던 화면이 그대로 남고, 답변 끝이 입력창 뒤로
    // 숨었다(390px 에서 키보드 344px·다섯 줄 437px 실측). 따라가는 중이면 끝으로 다시 붙인다.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (followBottomRef.current) el.scrollTop = el.scrollHeight;
          });
    resizeObserver?.observe(el);

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      resizeObserver?.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [conversationId]);

  // Another conversation opens at its end with following armed, whatever the
  // last one was left at. Declared above the append effect so a switch re-arms
  // before that effect decides whether to scroll.
  useEffect(() => {
    followBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [conversationId]);

  // 조각이 붙을 때마다가 아니라 다음 프레임에 한 번: 따라가는 중이면 끝으로 내리고,
  // 아니면 끝에서 얼마나 멀어졌는지만 다시 잰다(본문만 늘면 scroll 이벤트가 없다).
  useEffect(() => {
    if (followFrameRef.current !== null) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      const el = listRef.current;
      if (!el) return;
      if (followBottomRef.current) el.scrollTop = el.scrollHeight;
      else setShowJumpToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > BOTTOM_THRESHOLD_PX);
    });
  }, [messages, conversationId]);

  useEffect(
    () => () => {
      if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current);
    },
    [],
  );

  return { showJumpToBottom, scrollToBottom };
}
