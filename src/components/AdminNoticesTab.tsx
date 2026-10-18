import { useCallback, useEffect, useState } from "react";
import * as api from "../api/client";
import type { Notice } from "../api/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState, ListSkeleton, LoadFailed } from "./ListSkeleton";
import { showErrorToast, showToast } from "./Toast";
import { formatDateTime } from "../state/dateTime";

/**
 * 관리자 메뉴 › 공지사항 — 쓰고, 고치고, 삭제한다. 올린 공지는 모든 계정의 채팅 머리
 * 종 아이콘에 점으로 알려지고, 그 사람이 공지 창을 열면 점이 사라진다.
 */
export function AdminNoticesTab() {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Notice | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotices((await api.listNotices()).notices);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
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

      <section className="admin-notice-board" aria-label="올린 공지">
        <h2 className="admin-groups-title">올린 공지</h2>
        {notices === null && loadFailed ? (
          <LoadFailed message="공지 목록을 불러오지 못했습니다." onRetry={() => void load()} />
        ) : notices === null ? (
          <ListSkeleton rows={3} />
        ) : notices.length === 0 ? (
          // 쓰는 칸이 바로 옆에 있으므로 "공지 쓰기" 단추를 따로 두지 않는다 — 시작하는 길은 하나.
          <EmptyState
            title="올린 공지가 없습니다"
            reason="'새 공지' 칸에 쓰고 올리면 모든 계정의 대화 화면 종 아이콘에 새 공지로 알려집니다."
          />
        ) : (
          <ul className="admin-notice-list">
            {notices.map((notice) => (
              <li key={notice.id} className="admin-notice-item" data-editing={notice.id === editingId || undefined}>
                <div className="admin-notice-text">
                  <p className="admin-notice-title">{notice.title}</p>
                  <p className="admin-notice-meta">
                    {formatDateTime(notice.createdAt)} · {notice.authorName ?? notice.authorId}
                    {notice.updatedAt !== notice.createdAt && ` · ${formatDateTime(notice.updatedAt)} 고침`}
                  </p>
                  {notice.body && <p className="admin-notice-body">{notice.body}</p>}
                </div>
                <div className="admin-notice-buttons">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(notice.id);
                      setTitle(notice.title);
                      setBody(notice.body);
                    }}
                  >
                    고치기
                  </button>
                  <button type="button" className="btn btn-sm btn-danger-quiet" disabled={busy} onClick={() => setDeleting(notice)}>
                    삭제
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <ConfirmDialog
          title="공지를 삭제할까요?"
          message={`"${deleting.title}" 공지가 모든 계정의 공지 목록에서 사라집니다. 되돌릴 수 없습니다.`}
          confirmLabel="삭제"
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
                showToast("공지를 삭제했습니다.");
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
