import type React from "react";
import { useMemo, useState } from "react";
import * as api from "../api/client";
import type { BoardPostStatus, BoardPostView, BoardReplyView } from "../api/types";
import { boardPostHash } from "../routes";
import { exactTime, hueOf, initialOf, participantsOf, relativeTime, timelineOf } from "../state/boardFormat";
import { copyText } from "../state/clipboard";
import { errorMessage } from "../state/friendlyError";
import { isSubmitChord, Label, LinkIcon, MAX_BODY_CHARS, nameOf, PlainText, PlainTextField, ref, StatusIcon } from "./boardParts";
import { ConfirmDialog } from "./ConfirmDialog";
import { showToast } from "./Toast";

/* ------------------------------------------------------------------- 글 하나 */

interface DetailProps {
  post: BoardPostView;
  busy: boolean;
  onStatus: (post: BoardPostView, status: BoardPostStatus) => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
  /** 답변을 달았거나 고쳤다 — 새 글로 갈아 끼운다. */
  onReplied: (post: BoardPostView) => void;
  onError: (message: string) => void;
}

export function PostDetail({ post, busy, onStatus, onEdit, onDelete, onReplied, onError }: DetailProps) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const open = post.status === "open";
  const timeline = useMemo(() => timelineOf(post), [post]);
  const people = useMemo(() => participantsOf(post), [post]);
  const nameById = useMemo(() => new Map(people.map((p) => [p.id, nameOf(p.name, p.id)])), [people]);

  /** andToggle: GitLab 의 "댓글 달고 닫기" — 답을 남기고 그 자리에서 상태도 바꾼다. */
  async function send(andToggle = false) {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const body = await api.replyToBoardPost(post.id, text);
      setReply("");
      onReplied(body.post);
      if (andToggle) await onStatus(body.post, open ? "closed" : "open");
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function copyLink() {
    const url = `${window.location.origin}${window.location.pathname}${boardPostHash(post.id)}`;
    showToast((await copyText(url)) ? "글 주소를 복사했습니다." : "주소를 복사하지 못했습니다.");
  }

  return (
    <article className="board-issue">
      <header className="board-issue-head">
        <h3 className="board-issue-title">
          {post.title} <span className="board-issue-ref">{ref(post.number)}</span>
        </h3>
        <div className="board-issue-bar">
          <StatusPill status={post.status} />
          <span className="board-issue-byline">
            <Avatar name={post.authorName} id={post.authorId} size="sm" />
            <strong>{nameOf(post.authorName, post.authorId)}</strong> 님이{" "}
            <span title={exactTime(post.createdAt)}>{relativeTime(post.createdAt)}</span> 작성
          </span>
          {/* 서버가 판단해서 보낸 값이다 — 화면이 역할을 다시 따지지 않는다. */}
          {post.canManage && (
            <div className="board-issue-actions">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={onEdit}>
                수정
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void onStatus(post, open ? "closed" : "open")}>
                {open ? "문의 닫기" : "다시 열기"}
              </button>
              <button type="button" className="btn btn-sm btn-danger-quiet" disabled={busy} onClick={onDelete}>
                삭제
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="board-issue-grid">
        <div className="board-issue-main">
          <section className="board-note board-note-description" aria-label="본문">
            <NoteHead name={post.authorName} id={post.authorId} at={post.createdAt} editedAt={post.editedAt} isAuthor={false} />
            <div className="board-note-body">
              {post.body ? <PlainText text={post.body} /> : <p className="board-note-empty">설명이 없습니다.</p>}
            </div>
          </section>

          <h4 className="board-activity-title">
            활동 <span className="board-tab-count">{post.replies.length}</span>
          </h4>
          <ol className="board-timeline">
            {timeline.map((item) =>
              item.kind === "reply" ? (
                <li key={item.reply.id} className="board-timeline-item">
                  <Avatar name={item.reply.authorName} id={item.reply.authorId} />
                  <ReplyNote
                    postId={post.id}
                    reply={item.reply}
                    isAuthor={item.reply.authorId === post.authorId}
                    onSaved={onReplied}
                    onError={onError}
                  />
                </li>
              ) : (
                <li key={`closed-${item.at}`} className="board-timeline-item board-timeline-system">
                  <span className="board-timeline-dot" aria-hidden="true">
                    <StatusIcon status="closed" />
                  </span>
                  <p>
                    <strong>{nameById.get(item.by) ?? item.by}</strong> 님이{" "}
                    <span title={exactTime(item.at)}>{relativeTime(item.at)}</span> 문의를 닫았습니다
                  </p>
                </li>
              ),
            )}
            {timeline.length === 0 && <li className="board-timeline-none">아직 답변이 없습니다.</li>}
          </ol>

          {/* 닫힌 글에도 답변은 달 수 있다 — 닫았다고 대화가 끝나는 것은 아니다. */}
          <div className="board-reply-form">
            <PlainTextField
              id="board-reply"
              className="board-reply-input"
              rows={4}
              maxLength={MAX_BODY_CHARS}
              placeholder="답변을 적어 주세요."
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitChord(e)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="board-reply-foot">
              <span className="board-reply-hint">Ctrl+Enter 로 올립니다</span>
              {post.canManage && (
                <button type="button" className="btn" disabled={sending || busy || !reply.trim()} onClick={() => void send(true)}>
                  {open ? "답변하고 닫기" : "답변하고 다시 열기"}
                </button>
              )}
              <button type="button" className="btn btn-primary" disabled={sending || !reply.trim()} onClick={() => void send()}>
                {sending ? "올리는 중…" : "답변 올리기"}
              </button>
            </div>
          </div>
        </div>

        <aside className="board-issue-side" aria-label="문의 정보">
          <dl className="board-side-list">
            <div className="board-side-item">
              <dt>상태</dt>
              <dd>
                <StatusPill status={post.status} />
              </dd>
            </div>
            <div className="board-side-item">
              <dt>작성자</dt>
              <dd className="board-side-person">
                <Avatar name={post.authorName} id={post.authorId} size="sm" />
                {nameOf(post.authorName, post.authorId)}
              </dd>
            </div>
            <div className="board-side-item">
              <dt>라벨</dt>
              <dd className="board-side-labels">
                {post.tags.length > 0 ? post.tags.map((t) => <Label key={t} name={t} />) : <span className="board-side-none">없음</span>}
              </dd>
            </div>
            <div className="board-side-item">
              <dt>참여자 {people.length}명</dt>
              <dd className="board-side-avatars">
                {people.map((p) => (
                  <Avatar key={p.id} name={p.name} id={p.id} size="sm" title={nameOf(p.name, p.id)} />
                ))}
              </dd>
            </div>
            <div className="board-side-item">
              <dt>작성</dt>
              <dd>{exactTime(post.createdAt)}</dd>
            </div>
            <div className="board-side-item">
              <dt>최근 활동</dt>
              <dd title={exactTime(post.updatedAt)}>{relativeTime(post.updatedAt)}</dd>
            </div>
          </dl>
          <button type="button" className="btn btn-sm board-side-copy" onClick={() => void copyLink()}>
            <LinkIcon />
            글 주소 복사
          </button>
        </aside>
      </div>
    </article>
  );
}

/**
 * 답변 하나. 쓴 사람(과 관리자)은 그 자리에서 고친다 — 달 때와 같은 입력칸을
 * 쓴다. 고치는 동안의 글은 이 안에만 있어서, 다른 답변이 달려 글이
 * 새로 와도(key 가 답변 id 라) 쓰던 것이 날아가지 않는다.
 */
function ReplyNote({
  postId,
  reply,
  isAuthor,
  onSaved,
  onError,
}: {
  postId: string;
  reply: BoardReplyView;
  isAuthor: boolean;
  onSaved: (post: BoardPostView) => void;
  onError: (message: string) => void;
}) {
  /** null 이면 읽는 중, 문자열이면 고치는 중. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /** 고친 것이 있으면 묻고, 없으면 그냥 닫는다 — 새 글 쓰기와 같다. */
  function cancel(): void {
    if (saving) return;
    if (draft !== null && draft.trim() !== reply.body) setConfirmDiscard(true);
    else setDraft(null);
  }

  async function save() {
    const text = draft?.trim();
    if (!text || saving) return;
    if (text === reply.body) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      const body = await api.editBoardReply(postId, reply.id, text);
      setDraft(null);
      onSaved(body.post);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="board-note">
      <NoteHead
        name={reply.authorName}
        id={reply.authorId}
        at={reply.createdAt}
        editedAt={reply.editedAt}
        isAuthor={isAuthor}
        onEdit={reply.canEdit && draft === null ? () => setDraft(reply.body) : undefined}
      />
      {draft === null ? (
        <div className="board-note-body">
          <PlainText text={reply.body} />
        </div>
      ) : (
        <div className="board-reply-form board-note-editor">
          <PlainTextField
            className="board-reply-input"
            rows={4}
            maxLength={MAX_BODY_CHARS}
            aria-label="답변 고치기"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isSubmitChord(e)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="board-reply-foot">
            <span className="board-reply-hint">Ctrl+Enter 로 저장합니다</span>
            <button type="button" className="btn" disabled={saving} onClick={cancel}>
              취소
            </button>
            <button type="button" className="btn btn-primary" disabled={saving || !draft.trim()} onClick={() => void save()}>
              {saving ? "저장하는 중…" : "저장"}
            </button>
          </div>
        </div>
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="고치던 답변을 버릴까요?"
          message="고친 내용이 사라지고 답변은 그대로 남습니다."
          confirmLabel="버리기"
          danger
          onConfirm={() => {
            setConfirmDiscard(false);
            setDraft(null);
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}

function NoteHead({
  name,
  id,
  at,
  editedAt,
  isAuthor,
  onEdit,
}: {
  name: string | null;
  id: string;
  at: string;
  editedAt?: string;
  isAuthor: boolean;
  onEdit?: () => void;
}) {
  return (
    <header className="board-note-head">
      <strong>{nameOf(name, id)}</strong>
      <span className="board-note-handle">@{id}</span>
      <span className="board-note-time" title={exactTime(at)}>
        · {relativeTime(at)}
      </span>
      {/* GitLab 처럼 고쳤다는 사실만 붙이고, 언제 고쳤는지는 올려 보면 나온다. */}
      {editedAt && (
        <span className="board-note-time" title={`${exactTime(editedAt)} 수정`}>
          (수정됨)
        </span>
      )}
      {isAuthor && <span className="board-note-role">작성자</span>}
      {onEdit && (
        <button type="button" className="board-note-edit" onClick={onEdit}>
          수정
        </button>
      )}
    </header>
  );
}

function Avatar({ name, id, size, title }: { name: string | null; id: string; size?: "sm"; title?: string }) {
  return (
    <span
      className="board-avatar"
      data-size={size}
      style={{ "--avatar-hue": hueOf(id) } as React.CSSProperties}
      title={title}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? "img" : undefined}
    >
      {initialOf(name, id)}
    </span>
  );
}

function StatusPill({ status }: { status: BoardPostStatus }) {
  return (
    <span className="board-status" data-status={status}>
      <StatusIcon status={status} />
      {status === "open" ? "열림" : "닫힘"}
    </span>
  );
}
