import { useEffect, useState } from "react";
import "./ListSkeleton.css";

// 목록 자리의 세 상태 — 불러오는 중·불러오지 못함·비어 있음 — 를 한곳에 둔다.

/** 스켈레톤이 뜨기까지 기다리는 시간. 그 안에 끝나는 응답에서 회색 줄이 한 번
 *  번쩍이고 사라지면 오히려 느려 보인다. */
const SHOW_AFTER_MS = 300;

/**
 * 목록을 불러오는 동안 그 자리에 서는 회색 줄들. 화면 읽기 프로그램에는
 * 처음부터 '목록을 불러오는 중' 이 읽힌다(줄은 보이는 사람에게만 300ms 뒤에).
 */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="list-skeleton" role="status" aria-busy="true">
      <span className="visually-hidden">목록을 불러오는 중</span>
      {shown &&
        Array.from({ length: rows }, (_, index) => (
          <div key={index} className="list-skeleton-row" aria-hidden="true">
            <span className="list-skeleton-line" data-width="title" />
            <span className="list-skeleton-line" data-width="desc" />
          </div>
        ))}
    </div>
  );
}

/**
 * 목록을 불러오지 못했을 때 그 자리에 서는 안내. 실패를 맨 위 배너로만 알리면
 * 목록 자리가 '비어 있음' 으로 읽혀, 없는 것인지 못 가져온 것인지가 갈리지 않는다.
 */
export function LoadFailed({ message, detail, onRetry }: { message: string; detail?: string; onRetry: () => void }) {
  return (
    <div className="load-failed" role="alert">
      <p className="load-failed-message">{message}</p>
      {detail && <p className="load-failed-detail">{detail}</p>}
      <button type="button" className="btn btn-sm" onClick={onRetry}>
        다시 시도
      </button>
    </div>
  );
}

/**
 * 빈 목록: 제목 + 왜 비었는지 한 줄 + 다음에 할 일 단추 하나. 안내문만 두면
 * 읽은 사람이 무엇을 눌러야 하는지 다시 찾아야 한다.
 */
export function EmptyState({
  title,
  reason,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  title: string;
  reason: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      <p className="empty-state-reason">{reason}</p>
      {actionLabel && onAction && (
        <button type="button" className="btn btn-sm" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
