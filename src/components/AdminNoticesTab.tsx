import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { Notice } from "../api/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { showErrorToast, showToast } from "./Toast";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 관리자 메뉴 › 공지사항 — 쓰고, 고치고, 지운다. 올린 공지는 모든 계정의 채팅 머리
 * 종 아이콘에 점으로 알려지고, 그 사람이 공지 창을 열면 점이 사라진다.
 */
export function AdminNoticesTab() {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    try {
      setNotices((await api.listNotices()).notices);
    } catch (err) {
      showErrorToast(err);
      setNotices([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function reset() {
    setTitle("");
    setBody("");
    setEditingId(null);
  }

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (editingId) {
        await api.updateNotice(editingId, { title, body });
        showToast("공지를 고쳤습니다.");
      } else {
        await api.createNotice({ title, body });
        showToast("공지를 올렸습니다. 모든 계정에 새 공지로 표시됩니다.");
      }
      reset();
      await load();
    } catch (err) {
      showErrorToast(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-notices">
      <section className="admin-notice-form" aria-label={editingId ? "공지 고치기" : "새 공지"}>
        <h2 className="admin-groups-title">{editingId ? "공지 고치기" : "새 공지"}</h2>
        <div className="field">
          <label htmlFor="notice-title">제목</label>
          <input id="notice-title" type="text" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 18시 서버 점검 안내" />
        </div>
        <div className="field">
          <label htmlFor="notice-body">내용</label>
          <textarea id="notice-body" rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="사용자에게 알릴 내용을 적습니다." />
        </div>
        <div className="admin-notice-actions">
          {editingId && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={reset}>
              취소
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => void submit()}>
            {editingId ? "고친 내용 저장" : "공지 올리기"}
          </button>
        </div>
      </section>

      <section aria-label="올린 공지">
        <h2 className="admin-groups-title">올린 공지</h2>
        {notices === null ? (
          <p className="admin-empty">불러오는 중…</p>
        ) : notices.length === 0 ? (
          <p className="admin-empty">아직 올린 공지가 없습니다.</p>
        ) : (
          <ul className="admin-notice-list">
            {notices.map((notice) => (
              <li key={notice.id} className="admin-notice-item" data-editing={notice.id === editingId || undefined}>
                <div className="admin-notice-text">
                  <p className="admin-notice-title">{notice.title}</p>
                  <p className="admin-notice-meta">
                    {formatDate(notice.createdAt)} · {notice.authorName ?? notice.authorId}
                    {notice.updatedAt !== notice.createdAt && ` · ${formatDate(notice.updatedAt)} 고침`}
                  </p>
                  {notice.body && <p className="admin-notice-body">{notice.body}</p>}
                </div>
                <div className="admin-notice-buttons">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(notice.id);
                      setTitle(notice.title);
                      setBody(notice.body);
                    }}
                  >
                    고치기
                  </button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDeleting(notice)}>
                    지우기
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <ConfirmDialog
          title="공지 지우기"
          message={`"${deleting.title}" 공지를 지우시겠습니까? 모든 계정의 공지 목록에서 사라집니다.`}
          confirmLabel="지우기"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            setBusy(true);
            api
              .deleteNotice(target.id)
              .then(() => {
                if (editingId === target.id) reset();
                showToast("공지를 지웠습니다.");
                return load();
              })
              .catch(showErrorToast)
              .finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}
