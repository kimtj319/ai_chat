/**
 * PageUp·PageDown·Home·End 로 본문과 출처 창을 넘기는 규칙. 손으로 짠 판단만 여기 두고,
 * 화면을 만지는 일은 hooks/useScrollKeys.ts 가 한다.
 *
 * 왜 따로 받아야 하나: 브라우저는 이 키들을 **문서**나 포커스가 놓인 칸의 스크롤에
 * 준다. 이 앱의 스크롤은 문서가 아니라 안쪽 칸(.chat-message-list, 출처 창의 쪽 칸)이고,
 * 포커스는 대개 입력창이나 body 에 있어서 키가 어디에도 닿지 않았다.
 */

export type ScrollKeyAction = { kind: "page"; direction: 1 | -1 } | { kind: "edge"; edge: "start" | "end" };

/** 키를 누를 때 포커스가 놓인 곳. */
export type FocusKind =
  /** 대화 입력창. 글이 넘쳐 제 스크롤이 있을 때만 PageUp/Down 을 제가 갖는다. */
  | "composer"
  /** 다른 글 칸(input·textarea·select·contenteditable). 키는 모두 그 칸의 것이다. */
  | "editable"
  /** 이 키들이 제 뜻을 갖는 것(메뉴·목록·모달 대화상자). 건드리지 않는다. */
  | "widget"
  | "other";

export interface ScrollKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** 누가 이미 처리했다(메뉴의 Home/End 등). */
  defaultPrevented: boolean;
  /** 한글 조합 중. */
  isComposing: boolean;
  focus: FocusKind;
  /** 입력창이 스스로 스크롤할 만큼 글이 찼는가. */
  composerScrollable: boolean;
}

export function scrollKeyAction(input: ScrollKeyInput): ScrollKeyAction | null {
  const action: ScrollKeyAction | null =
    input.key === "PageDown"
      ? { kind: "page", direction: 1 }
      : input.key === "PageUp"
        ? { kind: "page", direction: -1 }
        : input.key === "Home"
          ? { kind: "edge", edge: "start" }
          : input.key === "End"
            ? { kind: "edge", edge: "end" }
            : null;
  if (!action) return null;
  if (input.defaultPrevented || input.isComposing) return null;
  // Ctrl/Cmd/Alt 를 함께 누른 것은 브라우저·OS 의 몫(탭 넘기기, 글 칸의 처음·끝 등).
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  switch (input.focus) {
    case "widget":
    case "editable":
      return null;
    case "composer":
      // Home/End 는 커서 옮기기, Shift 는 고르기다. 넘칠 만큼 쓴 글은 제가 넘긴다.
      if (input.shiftKey || action.kind === "edge" || input.composerScrollable) return null;
      return action;
    default:
      return action;
  }
}

/**
 * 어느 칸을 넘길까. 출처 창이 열려 있고 마지막으로 손댄 곳(포인터를 올렸거나 포커스가
 * 들어간 곳)이 그 창이면 창을, 아니면 대화 본문을. 창이 화면 전체를 덮는 좁은 화면에서는
 * 본문이 보이지 않으니 늘 창이다.
 */
export function scrollTarget(panel: { open: boolean; covers: boolean }, lastZone: "panel" | "chat" | null): "panel" | "chat" {
  if (!panel.open) return "chat";
  if (panel.covers) return "panel";
  return lastZone === "panel" ? "panel" : "chat";
}

/** 한 번에 넘길 거리 — 보이는 높이의 90%. 앞 화면의 마지막 줄 몇 개가 다음 화면 위에 남아 읽던 자리를 잃지 않는다. */
export function pageDistance(visibleHeight: number): number {
  return Math.max(40, Math.round(visibleHeight * 0.9));
}
