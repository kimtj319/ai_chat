import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePopoverFocus } from "../hooks/usePopoverFocus";
import { copyText } from "../state/clipboard";
import { sourceLinks } from "../state/sourceLinks";
import type { ChatMessage } from "../api/types";
import { CopyIcon } from "./CopyButton";
import { LinkIcon } from "./icons";
import { inSheet } from "./popoverSheet";
import { showToast } from "./Toast";
import "./SourcePicker.css";
import "./SourceLinks.css";

/** 한 번에 늘어놓는 수. 검색 도구는 부를 때마다 주소를 여럿 돌려줘 긴 대화에서는 백 개를 넘는다. */
const LIMIT = 50;

/**
 * 대화 머리의 "출처 링크" 단추 — "출처 문서" 바로 왼쪽.
 *
 * 답변이 웹 페이지에 기댔으면 나타나서, 그 페이지들을 최근 답변의 것부터 늘어놓는다
 * (무엇을 세는지는 state/sourceLinks.ts). 고르면 새 탭에서 열고, 옆의 단추로 주소만
 * 복사할 수 있다. 출처 문서와 한 무리로 읽히도록 단추·메뉴의 모양은 그쪽 클래스를
 * 그대로 쓴다 — 유리 막(glass.css)과 폰의 바텀시트(App.css)도 그래서 같이 따라온다.
 *
 * 파비콘은 그리지 않는다: 남의 서버(파비콘 서비스나 그 사이트)에 요청이 나가고, 사내망
 * 에서는 대개 막혀 빈 칸이 된다. 호스트의 첫 글자로 갈음한다.
 */
export function SourceLinks({ messages }: { messages: readonly ChatMessage[] }) {
  const links = useMemo(() => sourceLinks(messages), [messages]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery("(max-width: 640px)");

  usePopoverFocus(open, menuRef, triggerRef, () => setOpen(false));
  useDismiss(open, containerRef, () => setOpen(false), {
    ignore: (target) => menuRef.current?.contains(target) === true || target.closest?.(".popover-sheet-scrim") != null,
  });

  if (links.length === 0) return null;

  // 한 줄에 둘(여는 링크·복사)이다. 위아래는 같은 칸끼리, 좌우는 같은 줄 안에서 옮긴다.
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // 여기서 멈춘다: 열려 있는 출처 창과 생성 중단(Esc)도 window 에서 같은 키를 듣는다.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const row = active?.closest(".source-links-row");
      const target = row?.querySelector<HTMLElement>(event.key === "ArrowRight" ? ".source-links-copy" : ".source-links-item");
      if (!target) return;
      event.preventDefault();
      target.focus();
      return;
    }
    const column = active?.classList.contains("source-links-copy") ? ".source-links-copy" : ".source-links-item";
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(column) ?? [])];
    const at = items.indexOf(active as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  async function copy(url: string) {
    if (await copyText(url)) showToast("링크를 복사했습니다.");
    else showToast("링크를 복사하지 못했습니다.", "error");
  }

  const shown = links.slice(0, LIMIT);
  const label = `출처 링크 ${links.length}개`;
  return (
    <div className="source-picker source-links" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="source-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-tooltip="출처 링크"
        onClick={() => setOpen((v) => !v)}
      >
        <LinkIcon aria-hidden="true" />
        <span className="source-picker-count" aria-hidden="true">
          {links.length}
        </span>
      </button>
      {open &&
        inSheet(
          sheet,
          () => setOpen(false),
          <div ref={menuRef} className="source-picker-menu" role="menu" aria-label="출처 링크" tabIndex={-1} onKeyDown={onMenuKeyDown}>
            <p className="source-picker-title">출처 링크</p>
            {shown.map((link) => (
              <div key={link.url} className="source-links-row" role="none">
                <a
                  role="menuitem"
                  className="source-picker-item source-links-item"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.url}
                  onClick={() => setOpen(false)}
                >
                  <span className="source-links-mark" aria-hidden="true">
                    {link.hostname.charAt(0).toUpperCase()}
                  </span>
                  <span className="source-links-text">
                    <span className="source-picker-name">{link.title}</span>
                    <span className="source-links-host">
                      {link.hostname}
                      {link.count > 1 && ` · 답변 ${link.count}`}
                    </span>
                  </span>
                </a>
                <button
                  type="button"
                  role="menuitem"
                  className="source-links-copy"
                  aria-label={`링크 복사: ${link.title}`}
                  data-tooltip="링크 복사"
                  onClick={() => void copy(link.url)}
                >
                  <CopyIcon />
                </button>
              </div>
            ))}
            {links.length > LIMIT && (
              <p className="source-links-note">
                최근 {LIMIT}개만 보입니다 · 전체 {links.length}개
              </p>
            )}
          </div>,
        )}
    </div>
  );
}
