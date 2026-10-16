import type { ReactNode } from "react";
import "./Accordion.css";

/**
 * 가로로 긴 줄을 누르면 그 자리에서 아래로 열리며 자세한 내용이 보인다(라이브러리).
 * 한 목록에서 한 줄만 열린다 — 다시 누르면 닫힌다. 스위치는 줄 오른쪽 끝에 따로 있어
 * 누른다고 열리지 않는다.
 */
interface Props<T> {
  items: T[];
  idOf: (item: T) => string;
  openId: string | null;
  onToggle: (id: string) => void;
  renderHead: (item: T) => ReactNode;
  renderTrailing?: (item: T) => ReactNode;
  renderBody: (item: T) => ReactNode;
}

export function Accordion<T>({ items, idOf, openId, onToggle, renderHead, renderTrailing, renderBody }: Props<T>) {
  return (
    <div className="acc-list">
      {items.map((item) => {
        const id = idOf(item);
        const open = id === openId;
        return (
          <div key={id} className="acc-row" data-open={open || undefined}>
            <div className="acc-head">
              <button type="button" className="acc-main" aria-expanded={open} onClick={() => onToggle(id)}>
                {renderHead(item)}
              </button>
              {renderTrailing && <div className="acc-trailing">{renderTrailing(item)}</div>}
            </div>
            {/* 높이를 0fr → 1fr 로 옮겨 내용의 실제 높이만큼 부드럽게 열린다. 닫힌 내용은
                inert 라 탭으로 들어가지도 화면 낭독기가 읽지도 않는다. */}
            <div className="acc-panel" inert={!open || undefined}>
              <div className="acc-panel-inner">
                <div className="acc-body">{renderBody(item)}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
