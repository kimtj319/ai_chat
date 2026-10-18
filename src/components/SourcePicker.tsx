import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePopoverFocus } from "../hooks/usePopoverFocus";
import { citedDocuments } from "../state/citations";
import { openSource, useOpenSource } from "../state/sourcePanel";
import type { ClientChatMessage } from "../state/types";
import { DocumentIcon } from "./icons";
import { inSheet } from "./popoverSheet";
import "./SourcePicker.css";

/**
 * 대화 머리 오른쪽, 아이콘 묶음 바로 왼쪽의 "출처 문서" 단추.
 *
 * 답변이 문서를 인용했으면 나타나서, 이 대화가 인용한 문서들을 최근 것부터 늘어놓는다.
 * 고르면 출처 창이 그 문서를(가장 최근 답변이 인용한 단락에서) 연다 — 본문을 거슬러
 * 올라가 "[n]" 을 찾지 않아도 불러온 문서 사이를 오갈 수 있다. 한 번 연 문서는 캐시에
 * 남아 있어(state/sourceCache.ts) 오가는 것이 바로바로다.
 *
 * 폰에서는 다른 머리 메뉴처럼 바텀시트로 뜬다(popoverSheet).
 */
export function SourcePicker({ messages }: { messages: readonly ClientChatMessage[] }) {
  const documents = useMemo(() => citedDocuments(messages), [messages]);
  const openDocumentId = useOpenSource()?.documentId ?? null;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery("(max-width: 640px)");

  // 열면 포커스가 첫 문서로 들어간다. Esc 는 아래 onKeyDown 이 먼저 받는다(출처 창까지 닫히지 않게).
  usePopoverFocus(open, menuRef, triggerRef, () => setOpen(false));
  useDismiss(open, containerRef, () => setOpen(false), {
    // 시트는 body 로 포털되어 containerRef 밖에 있다. 스크림은 제 click 으로 닫는다.
    ignore: (target) => menuRef.current?.contains(target) === true || target.closest?.(".popover-sheet-scrim") != null,
  });

  if (documents.length === 0) return null;

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // 여기서 멈춘다: 열려 있는 출처 창과 생성 중단(Esc)도 window 에서 같은 키를 듣는다.
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
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

  const label = `출처 문서 ${documents.length}개`;
  return (
    <div className="source-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="source-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-tooltip="출처 문서"
        onClick={() => setOpen((v) => !v)}
      >
        <DocumentIcon aria-hidden="true" />
        <span className="source-picker-count" aria-hidden="true">
          {documents.length}
        </span>
      </button>
      {open &&
        inSheet(
          sheet,
          () => setOpen(false),
          <div ref={menuRef} className="source-picker-menu" role="menu" aria-label="출처 문서" tabIndex={-1} onKeyDown={onMenuKeyDown}>
            <p className="source-picker-title">출처 문서</p>
            {documents.map((doc) => {
              const current = doc.documentId === openDocumentId;
              return (
                <button
                  key={doc.documentId}
                  type="button"
                  role="menuitem"
                  className={`source-picker-item${current ? " current" : ""}`}
                  aria-current={current || undefined}
                  onClick={() => {
                    setOpen(false);
                    openSource(doc.source);
                  }}
                >
                  <DocumentIcon aria-hidden="true" />
                  <span className="source-picker-name">{doc.title || "출처"}</span>
                  <span className="source-picker-meta">인용 {doc.count}</span>
                </button>
              );
            })}
          </div>,
        )}
    </div>
  );
}
