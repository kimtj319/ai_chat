import { useEffect, useRef, useState } from "react";
import { HASHES, type View } from "../routes";
import { pushOverlay } from "../ui/overlayStack";
import { useMediaQuery } from "./useMediaQuery";
import { FOCUSABLE } from "./usePopoverFocus";

interface DrawerOptions {
  view: View;
  activeConversationId: string | null;
  /** The sidebar renders a different <aside> when collapsed; the dialog role is re-applied to it. */
  sidebarCollapsed: boolean;
  navigate: (view: View) => void;
}

/**
 * The sidebar as a drawer on a narrow screen: open/closed state, the dialog
 * role and focus handling while it is open, closing it when something is
 * picked, and reopening it on the way back to where it was left.
 */
export function useDrawer({ view, activeConversationId, sidebarCollapsed, navigate }: DrawerOptions) {
  // 좁은 화면에서는 사이드바가 붙박이 칸을 그만두고 떠 있는 서랍이 된다.
  // 기준점은 CSS 와 같은 1024px 이다 — 여기서 구조가 바뀌고(스크림·Esc·자동
  // 닫기), 저기서 모양이 바뀐다.
  const narrow = useMediaQuery("(max-width: 1024px)");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  const shellRef = useRef<HTMLDivElement>(null);
  // 열린 서랍은 대화상자다: 그 밖은 inert 로 막고(Tab·스크린리더 모두), 포커스를 안으로
  // 데려간다. 닫을 때 메뉴 단추로 돌려주는 것은 아래 effect 가 맡는다.
  const drawerModal = narrow && drawerOpen;
  // 서랍을 닫으면 포커스를 메뉴 단추로 돌려준다. 닫기 단추가 숨은 서랍 안에 포커스를
  // 쥔 채 남으면, iOS 에서 그 뒤의 본문이 손가락 스크롤을 받지 못하는 일이 있다
  // (키보드 사용자에게도 포커스가 사라진 것처럼 보인다).
  useEffect(() => {
    if (drawerWasOpen.current && !drawerOpen) {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".sidebar")) active.blur();
      requestAnimationFrame(() => drawerToggleRef.current?.focus({ preventScroll: true }));
    }
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);

  // <aside> 는 Sidebar 의 것이라 역할은 여기서 DOM 에 직접 단다. 사이드바가 접힘
  // 선호값에 따라 다른 <aside> 를 그리므로 그것이 바뀔 때도 다시 단다.
  useEffect(() => {
    const aside = shellRef.current?.querySelector<HTMLElement>(":scope > aside.sidebar");
    if (!aside) return;
    if (!drawerModal) {
      aside.removeAttribute("role");
      aside.removeAttribute("aria-modal");
      aside.removeAttribute("aria-label");
      return;
    }
    aside.setAttribute("role", "dialog");
    aside.setAttribute("aria-modal", "true");
    aside.setAttribute("aria-label", "메뉴");
  }, [drawerModal, sidebarCollapsed]);

  useEffect(() => {
    if (!drawerModal) return;
    const aside = shellRef.current?.querySelector<HTMLElement>(":scope > aside.sidebar");
    // 미끄러져 들어오는 중이라 스크롤은 막는다.
    aside?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [drawerModal]);

  // 서랍은 무엇을 고르면 닫힌다. 무엇을 골랐는지는 주소와 열린 대화가 말해 주므로
  // 사이드바 안의 버튼 하나하나에 손을 댈 필요가 없다 — 설정 팝오버처럼
  // 화면을 옮기지 않는 것을 눌렀을 때 서랍이 닫히지 않는 것도 같은 이유다.
  //
  // 예외는 뒤로 가기다. 서랍에서 라이브러리·문서로 갔다가 뒤로(왼쪽 끝에서 쓸어 넘기기,
  // 브라우저 뒤로) 오면 떠났던 자리, 곧 열린 서랍으로 돌아와야 한다. 떠날 때 그 기록에
  // 표시를 남기고(navigateFromDrawer), 돌아와 한 번 쓰면 지운다 — 남겨 두면 그 화면에서
  // 대화를 고를 때마다 서랍이 다시 열린다.
  useEffect(() => {
    const state = window.history.state as { drawerOpen?: boolean } | null;
    const reopen = narrow && state?.drawerOpen === true;
    if (reopen) window.history.replaceState({ ...state, drawerOpen: undefined }, "");
    setDrawerOpen(reopen);
    // narrow 는 일부러 뺀다 — 폭이 바뀐 것은 무엇을 고른 것이 아니다(아래 effect 가 맡는다).
  }, [view, activeConversationId]);

  /** 서랍에서 다른 화면으로 갈 때. 지금 기록에 "서랍이 열려 있었다" 를 남긴다. */
  function navigateFromDrawer(target: View) {
    if (narrow && drawerOpen && HASHES[target] !== window.location.hash) {
      window.history.replaceState({ ...(window.history.state ?? {}), drawerOpen: true }, "");
    }
    navigate(target);
  }

  // 창을 넓히면 서랍이라는 개념 자체가 사라진다. 열린 채로 두면 넓은 화면에
  // 쓸모없는 스크림만 남는다.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  // 열려 있는 동안은 Esc 가 서랍의 몫이다 — 생성 중단과 겹치지 않게.
  useEffect(() => (drawerOpen ? pushOverlay() : undefined), [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // Ctrl/Cmd+K(대화 검색)는 사이드바가 맡는다. 좁은 화면에서 서랍이 닫혀 있으면 검색 칸이
  // 보이지 않으므로 서랍을 먼저 열고, 서랍이 제 첫 항목으로 포커스를 옮긴 뒤 검색 칸으로 보낸다.
  useEffect(() => {
    if (!narrow || drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.code !== "KeyK" && event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setDrawerOpen(true);
      window.setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>(".sidebar-search-input");
        input?.focus();
        input?.select();
      }, 60);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [narrow, drawerOpen]);

  return { narrow, drawerOpen, setDrawerOpen, drawerModal, drawerToggleRef, shellRef, navigateFromDrawer };
}
