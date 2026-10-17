import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import type { Notice } from "../api/types";
import { usePopoverFocus } from "../hooks/usePopoverFocus";
import { useDismiss } from "../hooks/useDismiss";
import { formatDateTime } from "../state/dateTime";
import "./NoticeButton.css";

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** 새 공지가 올라왔는지 다시 볼 간격. 탭으로 돌아올 때(focus)도 다시 본다. */
const REFRESH_MS = 5 * 60 * 1000;

/**
 * 채팅 머리 오른쪽의 공지사항 단추.
 *
 * 마지막으로 열어 본 뒤에 올라온 공지가 있으면 종 위에 점이 찍힌다. 열면 목록이 뜨고,
 * 연 순간 "봤다" 가 서버에 남아 점이 사라진다 — 다른 기기에서 열어도 같다.
 */
export function NoticeButton() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await api.listNotices();
      setNotices(body.notices);
      setUnread(body.unread);
    } catch {
      // 공지를 못 읽어도 채팅은 그대로다. 다음 새로 고침에서 다시 본다.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // 열면 포커스가 목록으로 들어가고, Esc 는 종 단추로 돌려준다.
  usePopoverFocus(open, popoverRef, triggerRef, () => setOpen(false));
  useDismiss(open, containerRef, () => setOpen(false));

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    // 여는 순간의 목록을 다시 받아 둔다 — 방금 올라온 공지도 이 창에 보여야 한다.
    await refresh();
    // 연 것이 곧 본 것이다. refresh 가 다시 세어 둔 수도 여기서 지운다.
    setUnread(0);
    api.markNoticesSeen().catch(() => {
      // 못 남겼으면 다음에 다시 점이 뜬다. 지금 본 사람에게 다시 띄울 일은 아니다.
    });
  }

  const label = unread > 0 ? `공지사항 (새 공지 ${unread}건)` : "공지사항";
  return (
    <div className="notice-button" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        data-tooltip={label}
        onClick={() => void toggle()}
      >
        <BellIcon />
        {unread > 0 && <span className="notice-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div ref={popoverRef} className="notice-popover" role="dialog" aria-label="공지사항" tabIndex={-1}>
          <p className="notice-popover-title">공지사항</p>
          {notices.length === 0 ? (
            <p className="notice-empty">아직 공지가 없습니다.</p>
          ) : (
            <ul className="notice-list">
              {notices.map((notice) => (
                <li key={notice.id} className="notice-item">
                  <p className="notice-item-title">{notice.title}</p>
                  <p className="notice-item-meta">
                    {formatDateTime(notice.createdAt)} · {notice.authorName ?? notice.authorId}
                  </p>
                  {notice.body && <p className="notice-item-body">{notice.body}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
