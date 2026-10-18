import type { ReactNode } from "react";
import { NoticeButton } from "./NoticeButton";
import "./PageHeader.css";

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 없으면 뒤로 단추를 그리지 않는다. */
  onBack?: () => void;
  /** 오른쪽 동작 자리. 페이지마다 주 동작은 하나만 둔다. */
  actions?: ReactNode;
}

/**
 * 사이드바 옆 페이지들의 공용 머리. 페이지마다 머리 CSS 를 따로 두던 때는
 * 폭·위 여백이 조금씩 달라 페이지를 옮길 때마다 제목이 튀었다 — 규칙은 여기
 * 한 벌뿐이다. 좁은 화면(서랍) 규칙은 App.css 가 `.page-header` 로 부른다.
 */
export function PageHeader({ title, subtitle, onBack, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      {onBack && (
        // data-back-to-chat: 서랍이 있는 화면에서는 App.css 가 이 단추를 숨긴다.
        <button
          type="button"
          className="btn-icon"
          onClick={onBack}
          data-tooltip="대화로 돌아가기"
          aria-label="대화로 돌아가기"
          data-back-to-chat
        >
          <BackIcon />
        </button>
      )}
      <div className="page-header-text">
        <h1 className="page-header-title">{title}</h1>
        {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
      </div>
      {/* 공지 종은 모든 페이지에 — 공지를 읽으려고 대화 화면으로 돌아가지 않게. 주 동작 오른쪽 끝. */}
      <div className="page-header-actions">
        {actions}
        <NoticeButton />
      </div>
    </header>
  );
}
