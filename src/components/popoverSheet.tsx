import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 폰에서는 팝오버를 바텀시트로: body 로 포털하고 뒤에 스크림을 깐다(누르면 닫힌다).
 * 넓은 화면에서는 제자리에 그대로 둔다. McpPicker 와 ReasoningControl 이 같이 쓴다.
 */
export function inSheet(sheet: boolean, onClose: () => void, popover: ReactNode): ReactNode {
  if (!sheet) return popover;
  return createPortal(
    <>
      <div className="popover-sheet-scrim" aria-hidden="true" onClick={onClose} />
      {popover}
    </>,
    document.body,
  );
}
