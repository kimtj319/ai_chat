import type { ReactNode } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import "./MasterDetail.css";

/**
 * 왼쪽에는 가로로 긴 항목 줄(이름·짧은 설명·스위치), 오른쪽에는 고른 항목의 자세한
 * 설명. 도구 설정과 라이브러리가 같이 쓴다.
 *
 * 좁은 화면에서는 두 칸을 둘 자리가 없어 고른 줄 바로 아래에 펼친다 — 구조가
 * 바뀌는 곳이라 CSS 가 아니라 useMediaQuery 로 가른다.
 */
export interface MasterDetailGroup<T> {
  key: string;
  title?: ReactNode;
  hint?: ReactNode;
  items: T[];
  /** 항목이 없을 때 이 묶음 자리에 보일 말. */
  empty?: ReactNode;
}

interface Props<T> {
  groups: MasterDetailGroup<T>[];
  idOf: (item: T) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 줄의 본문(이름·설명·배지). 누르면 고른다. */
  renderRow: (item: T) => ReactNode;
  /** 줄 오른쪽 끝(스위치). 고르기와 따로 눌린다. */
  renderTrailing?: (item: T) => ReactNode;
  renderDetail: (item: T) => ReactNode;
  /** 아무것도 고르지 않았을 때 오른쪽 칸. */
  placeholder: ReactNode;
  className?: string;
}

const NARROW = "(max-width: 860px)";

export function MasterDetail<T>({
  groups,
  idOf,
  selectedId,
  onSelect,
  renderRow,
  renderTrailing,
  renderDetail,
  placeholder,
  className,
}: Props<T>) {
  const narrow = useMediaQuery(NARROW);
  const selected = groups.flatMap((g) => g.items).find((item) => idOf(item) === selectedId) ?? null;

  return (
    <div className={`md-layout${className ? ` ${className}` : ""}`}>
      <div className="md-list">
        {groups.map((group) => (
          <section key={group.key} className="md-group">
            {group.title && <h3 className="md-group-title">{group.title}</h3>}
            {group.hint && <p className="md-group-hint">{group.hint}</p>}
            {group.items.length === 0 && group.empty && <p className="md-group-empty">{group.empty}</p>}
            {group.items.map((item) => {
              const id = idOf(item);
              const isSelected = id === selectedId;
              return (
                <div key={id} className="md-row" data-selected={isSelected || undefined}>
                  <div className="md-row-head">
                    <button
                      type="button"
                      className="md-row-main"
                      aria-expanded={narrow ? isSelected : undefined}
                      aria-pressed={narrow ? undefined : isSelected}
                      onClick={() => onSelect(id)}
                    >
                      {renderRow(item)}
                    </button>
                    {renderTrailing && <div className="md-row-trailing">{renderTrailing(item)}</div>}
                  </div>
                  {narrow && isSelected && (
                    <div className="md-inline-detail" key={id}>
                      {renderDetail(item)}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {!narrow && (
        <div className="md-detail" aria-live="polite">
          {/* key 로 다시 그려 고를 때마다 들어오는 움직임이 다시 돈다. */}
          <div className="md-detail-inner" key={selected ? idOf(selected) : "none"}>
            {selected ? renderDetail(selected) : <div className="md-placeholder">{placeholder}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
