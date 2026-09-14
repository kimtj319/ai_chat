import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { pushOverlay } from "../ui/overlayStack";
import "./Modal.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Opt-in wider layout for modals with more content to scan at once (e.g. the tools grid). Every other dialog is unaffected. */
  size?: "wide";
}

/** Tab 이 닿을 수 있는 것들. disabled 와 숨겨진 것은 빠진다. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // 화면에 없는 것은 순환에서 뺀다 — 보이지 않는 칸에 포커스가 들어가면
    // 키보드 사용자에게는 포커스가 사라진 것처럼 보인다.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function Modal({ title, onClose, children, width, size }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      // aria-modal="true" 는 보조 기술에게 "여기가 전부다" 라고 말한다. 그
      // 말이 사실이 되려면 Tab 도 여기서 돌아야 한다 — 그러지 않으면 대화상자가
      // 떠 있는데 포커스는 뒤쪽 페이지의 버튼을 짚고 있게 된다.
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = focusableIn(dialog);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (active instanceof Node && !dialog.contains(active)) {
        // 바깥에서 Tab 으로 들어오려는 경우. 첫 칸으로 데려온다.
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // 떠 있는 동안은 Esc 가 이쪽 몫이다. 전역 Esc(생성 중단)가 함께 터지지
  // 않도록 알려 둔다.
  useEffect(() => pushOverlay(), []);

  // 열릴 때 포커스를 데려오고, 닫을 때 원래 자리로 돌려보낸다. 돌려보내지
  // 않으면 키보드 사용자는 대화상자를 닫은 뒤 문서 맨 처음부터 다시 Tab 해야
  // 한다 — 방금 누른 버튼이 어디였는지와 상관없이.
  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = focusableIn(dialog).find((el) => !el.classList.contains("modal-close"));
      // 첫 입력 칸이 있으면 그곳으로. 없으면 대화상자 자체로 — 어느 쪽이든
      // 스크린리더가 제목부터 읽기 시작한다.
      (first ?? dialog).focus();
    }
    return () => {
      // 사라진 요소에 포커스를 주려 하면 body 로 떨어진다. 아직 문서에 있을
      // 때만 되돌린다.
      if (restoreTo && restoreTo.isConnected) restoreTo.focus();
    };
  }, []);

  // Rendered into <body>, never in place.
  //
  // `position: fixed` resolves against the viewport ONLY while no ancestor
  // establishes a containing block, and backdrop-filter does establish one —
  // so the dialogs the glass sidebar hosts (delete a conversation, change a
  // password, edit endpoints, confirm a logout) were laying themselves out
  // inside the sidebar: a 280px-wide scrim and a dialog centred on the rail
  // instead of on the screen. A portal puts the overlay outside that box, so
  // "fixed" means the window again no matter who opened the dialog.
  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={`modal${size === "wide" ? " modal-wide" : ""}`}
        style={width ? { maxWidth: width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // 포커스를 받을 수 있게 하되 Tab 차례에는 끼지 않는다.
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기" data-tooltip="닫기">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
