import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { pushOverlay } from "../ui/overlayStack";
import { CloseIcon } from "./icons";
import "./Modal.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Opt-in wider layout for modals with more content to scan at once (e.g. the tools grid). Every other dialog is unaffected. */
  size?: "wide";
  /**
   * false 면 바깥(어두운 막)을 눌러도 닫히지 않는다. 입력 칸이 여럿인 양식이 고친
   * 내용을 들고 있을 때 쓴다 — 빗나간 클릭 한 번에 적어 둔 것이 말없이 사라지면 안 된다.
   * Esc·닫기·취소처럼 일부러 닫는 길은 그대로 둔다.
   */
  dismissOnBackdrop?: boolean;
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

export function Modal({ title, onClose, children, width, size, dismissOnBackdrop = true }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // 겹쳐 뜬 대화상자(지우기 확인 등)는 각자 포털이라 서로의 안에 있지 않다.
      // 맨 위 것만 키를 받는다 — 그러지 않으면 바깥 것의 Tab 가두기가 안쪽
      // 대화상자에서 포커스를 빼앗는다. 포털은 열린 차례대로 body 끝에 붙으므로
      // 문서 순서의 마지막이 맨 위다.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== dialogRef.current) return;
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
    // 되돌릴 자리가 사라지거나 숨을 때를 위해 그 위쪽 줄기를 적어 둔다 — 대화 목록의
    // 삭제 단추는 행에 포커스가 없으면 감춰지고, 삭제를 확정하면 행째 없어진다.
    const ancestors: HTMLElement[] = [];
    for (let el = restoreTo?.parentElement; el && el !== document.body; el = el.parentElement) ancestors.push(el);
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
      // 그래도 body 에 떨어졌으면(되돌릴 단추가 숨었거나 없어졌으면), 아직 남은 가장
      // 가까운 윗 요소 안의 보이는 첫 조작 요소로 보낸다 — 키보드 사용자가 문서 맨
      // 처음부터 다시 Tab 하지 않도록(감사 A3-08). 지우기를 확정하면 행은 서버가
      // 답한 뒤에야 없어지므로, 닫힌 직후 한 번이 아니라 잠시 동안 몇 번 더 본다.
      const fallBack = () => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        for (const scope of ancestors) {
          if (!scope.isConnected) continue;
          const target = focusableIn(scope)[0];
          if (target) {
            target.focus();
            return;
          }
        }
      };
      requestAnimationFrame(fallBack);
      for (const ms of [300, 1000, 2000]) window.setTimeout(fallBack, ms);
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
    <div className="modal-overlay" onMouseDown={dismissOnBackdrop ? onClose : undefined}>
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
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
