import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/client";
import type { BoardPostStatus, BoardPostSummary, BoardPostView } from "../api/types";
import { BOARD_HASH, boardPostHash, boardPostIdFromHash } from "../routes";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import "./BoardPage.css";

/**
 * 문의 게시판.
 *
 * 이슈 목록의 모양을 빌렸다 — 열림/닫힘 탭, 태그, 답변 수. 그게 이 화면에서
 * 사람이 실제로 하는 일과 맞기 때문이다: 내 문제가 이미 올라와 있는지 훑고,
 * 없으면 올리고, 답이 달리면 닫는다.
 *
 * 목록과 글을 **같은 화면이 갈아 끼운다**(모달이 아니라). 답변 스레드는 길어질
 * 수 있고, 모달 안에서 답을 쓰게 하면 읽던 글을 가린 채로 쓰게 된다. 대신
 * 모달이었다면 공짜로 얻었을 것 — 뒤로가기로 닫히고, 새로고침해도 제자리 — 을
 * 직접 해야 한다. 그래서 **주소가 지금 무엇을 보고 있는지를 말한다**:
 * #/board 는 목록, #/board/<id> 는 그 글. 브라우저 뒤로·앞으로도 이 한 경로로
 * 들어오고, 읽던 글의 주소를 그대로 건네줄 수 있다.
 */

interface Props {
  onBack: () => void;
}

type Tab = BoardPostStatus;

/** 화면에서도 막아 둔다. 서버가 잘라 내기 전에 사람이 먼저 알아야 한다. */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 20_000;
const MAX_TAGS = 8;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

/** 계정 이름이 있으면 이름, 없으면 id — 없는 이름을 지어내지 않는다. */
function who(name: string | null, id: string): string {
  return name ? `${name} (${id})` : id;
}

/** 여러 줄 입력에서의 제출. Enter 는 줄바꿈으로 남겨 둬야 하므로 수식키를 쓴다. */
function isSubmitChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

export function BoardPage({ onBack }: Props) {
  const [posts, setPosts] = useState<BoardPostSummary[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("open");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [postId, setPostId] = useState<string | null>(() => boardPostIdFromHash(window.location.hash));
  const [post, setPost] = useState<BoardPostView | null>(null);
  const [postLoading, setPostLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [confirming, setConfirming] = useState<BoardPostView | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  /** 이 주소를 우리가 밀어 넣었는가 — 뒤로 버튼이 history 를 되감아도 되는지 가른다. */
  const pushedRef = useRef(false);

  /* ------------------------------------------------------------ 주소 ↔ 화면 */

  useEffect(() => {
    const sync = () => setPostId(boardPostIdFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function showPost(id: string): void {
    pushedRef.current = true;
    window.location.hash = boardPostHash(id);
  }

  function showList(): void {
    // 우리가 밀어 넣은 주소면 되감는다. 새 주소를 또 쌓으면 브라우저 뒤로가
    // 방금 빠져나온 글로 되돌아가 버린다.
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    } else {
      window.location.hash = BOARD_HASH;
    }
  }

  /* --------------------------------------------------------------- 불러오기 */

  const reload = useCallback(async () => {
    setListLoading(true);
    try {
      const body = await api.listBoardPosts();
      setPosts(body.posts);
      setKnownTags(body.tags);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 보는 글이 바뀌면 그 글을 가져온다. 주소로 곧장 들어왔을 때도 같은 길이다.
  useEffect(() => {
    // 화면이 바뀌었으니 지난 오류는 지운다 — 다른 화면의 실패를 여기 붙여 둘 이유가 없다.
    setError(null);
    // 목록을 한참 내려다보다 글을 열면 같은 스크롤 상자를 물려받아 글 중간이
    // 펼쳐진다. 새 화면은 위에서 시작해야 한다.
    bodyRef.current?.scrollTo({ top: 0 });

    if (!postId) {
      setPost(null);
      return;
    }
    let alive = true;
    setPostLoading(true);
    api
      .getBoardPost(postId)
      .then((body) => {
        if (alive) setPost(body.post);
      })
      .catch((err) => {
        if (!alive) return;
        setPost(null);
        setError(messageOf(err));
      })
      .finally(() => {
        if (alive) setPostLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [postId]);

  /* ----------------------------------------------------------------- 셈하기 */

  // 태그를 걸면 탭의 숫자도 함께 줄어든다. 목록에는 한 건만 보이는데 탭에는
  // "열림 12" 라고 적혀 있으면, 둘 중 무엇이 거짓말인지 알 수 없다.
  const inScope = useMemo(
    () => posts.filter((p) => !tagFilter || p.tags.includes(tagFilter)),
    [posts, tagFilter],
  );

  const counts = useMemo(
    () => ({
      open: inScope.filter((p) => p.status === "open").length,
      closed: inScope.filter((p) => p.status === "closed").length,
    }),
    [inScope],
  );

  const visible = useMemo(() => inScope.filter((p) => p.status === tab), [inScope, tab]);

  /* ------------------------------------------------------------------ 동작 */

  async function run<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      const result = await work();
      setError(null);
      return result;
    } catch (err) {
      setError(messageOf(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(target: BoardPostView, status: BoardPostStatus): Promise<void> {
    const body = await run(() => api.setBoardPostStatus(target.id, status));
    if (body) {
      setPost(body.post);
      void reload();
    }
  }

  async function removePost(target: BoardPostView): Promise<void> {
    const ok = await run(() => api.deleteBoardPost(target.id).then(() => true));
    if (ok) {
      setConfirming(null);
      showList();
      void reload();
    }
  }

  /* ------------------------------------------------------------------ 화면 */

  const onDetail = postId !== null;

  return (
    <section className="board-page">
      <header className="board-header">
        <button
          type="button"
          className="btn-icon board-back"
          onClick={onDetail ? showList : onBack}
          // 같은 자리의 버튼이지만 가는 곳이 다르다. 화면을 못 보는 사람에게는
          // 이 문구가 유일한 단서다.
          aria-label={onDetail ? "게시판 목록으로" : "대화로 돌아가기"}
          data-tooltip={onDetail ? "목록으로" : "대화로"}
        >
          <BackIcon />
        </button>
        <div className="board-header-text">
          <h2 className="board-title">문의 게시판</h2>
          <p className="board-subtitle">
            {onDetail
              ? post
                ? `${post.status === "open" ? "열림" : "닫힘"} · 답변 ${post.replies.length}개`
                : "글을 불러오는 중"
              : `열림 ${counts.open}개 · 닫힘 ${counts.closed}개${tagFilter ? ` · #${tagFilter} 만` : ""}`}
          </p>
        </div>
        {!onDetail && (
          <button type="button" className="btn btn-primary" onClick={() => setComposing(true)} disabled={busy}>
            문의 올리기
          </button>
        )}
      </header>

      <div className="board-body" ref={bodyRef}>
        {error && (
          <p className="board-error" role="alert">
            {error}
            <button type="button" className="board-banner-close" onClick={() => setError(null)} aria-label="닫기">
              ×
            </button>
          </p>
        )}

        {onDetail ? (
          postLoading && !post ? (
            <p className="board-loading">글을 불러오는 중…</p>
          ) : post ? (
            <PostDetail
              post={post}
              busy={busy}
              onStatus={changeStatus}
              onDelete={() => setConfirming(post)}
              onReplied={(next) => {
                setPost(next);
                void reload();
              }}
              onError={setError}
            />
          ) : (
            // 지워졌거나, 주소를 잘못 받았거나. 막다른 길에 세워 두지 않는다.
            <div className="board-row-empty">
              <p>글을 열 수 없습니다.</p>
              <button type="button" className="btn" onClick={showList}>
                목록으로
              </button>
            </div>
          )
        ) : (
          <>
            <div className="board-tabs" role="tablist">
              {(["open", "closed"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className="board-tab"
                  data-selected={tab === t || undefined}
                  onClick={() => setTab(t)}
                >
                  {t === "open" ? "열림" : "닫힘"} <span className="board-tab-count">{counts[t]}</span>
                </button>
              ))}
              {tagFilter && (
                <button type="button" className="board-tag-clear" onClick={() => setTagFilter(null)}>
                  #{tagFilter} 해제
                </button>
              )}
            </div>

            {knownTags.length > 0 && (
              <div className="board-tagbar">
                {knownTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="board-tag"
                    data-selected={tagFilter === t || undefined}
                    onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            )}

            <ul className="board-list">
              {/* 불러오는 동안 빈 화면을 보여 주면, 글이 없는 것인지 아직 안 온
                  것인지 구분할 수 없다. */}
              {listLoading && posts.length === 0 && <li className="board-row-empty">불러오는 중…</li>}

              {visible.map((summary) => (
                <li key={summary.id} className="board-row" data-status={summary.status}>
                  <button type="button" className="board-row-title" onClick={() => showPost(summary.id)}>
                    {summary.title}
                  </button>
                  {summary.tags.map((t) => (
                    <span key={t} className="board-badge">
                      #{t}
                    </span>
                  ))}
                  {summary.replyCount > 0 && (
                    <span className="board-badge" data-tone="reply">
                      답변 {summary.replyCount}
                    </span>
                  )}
                  <span className="board-row-meta">
                    {who(summary.authorName, summary.authorId)} · {formatDate(summary.createdAt)}
                  </span>
                </li>
              ))}

              {visible.length === 0 && !listLoading && (
                <li className="board-row-empty">
                  {tagFilter
                    ? `#${tagFilter} 태그가 붙은 ${tab === "open" ? "열린" : "닫힌"} 문의가 없습니다.`
                    : tab === "open"
                      ? "열린 문의가 없습니다. 궁금한 것이 있으면 올려 주세요."
                      : "닫힌 문의가 없습니다."}
                </li>
              )}
            </ul>
          </>
        )}
      </div>

      {composing && (
        <Composer
          knownTags={knownTags}
          onCancel={() => setComposing(false)}
          onDone={(created) => {
            setComposing(false);
            showPost(created.id);
            void reload();
          }}
          onError={setError}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="문의를 지울까요?"
          message={`"${confirming.title}" 과 달린 답변이 함께 사라집니다. 되돌릴 수 없습니다.`}
          confirmLabel="지우기"
          danger
          onConfirm={() => void removePost(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- 글 하나 */

interface DetailProps {
  post: BoardPostView;
  busy: boolean;
  onStatus: (post: BoardPostView, status: BoardPostStatus) => void;
  onDelete: () => void;
  onReplied: (post: BoardPostView) => void;
  onError: (message: string) => void;
}

function PostDetail({ post, busy, onStatus, onDelete, onReplied, onError }: DetailProps) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const body = await api.replyToBoardPost(post.id, text);
      setReply("");
      onReplied(body.post);
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <article className="board-detail">
      <div className="board-detail-head">
        <h3 className="board-detail-title">{post.title}</h3>
        <span className="board-badge" data-status={post.status}>
          {post.status === "open" ? "열림" : "닫힘"}
        </span>
        {post.tags.map((t) => (
          <span key={t} className="board-badge">
            #{t}
          </span>
        ))}
      </div>
      <p className="board-detail-meta">
        {who(post.authorName, post.authorId)} · {formatDate(post.createdAt)}
        {post.status === "closed" && post.closedAt ? ` · ${formatDate(post.closedAt)} 에 닫힘` : ""}
      </p>

      {post.body && <p className="board-detail-body">{post.body}</p>}

      {/* 서버가 판단해서 보낸 값이다 — 화면이 역할을 다시 따지지 않는다. */}
      {post.canManage && (
        <div className="board-detail-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onStatus(post, post.status === "open" ? "closed" : "open")}
          >
            {post.status === "open" ? "닫기" : "다시 열기"}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onDelete}>
            지우기
          </button>
        </div>
      )}

      <h4 className="board-replies-title">답변 {post.replies.length}개</h4>
      <ul className="board-replies">
        {post.replies.map((r) => (
          <li key={r.id} className="board-reply">
            <p className="board-reply-meta">
              {who(r.authorName, r.authorId)} · {formatDate(r.createdAt)}
            </p>
            <p className="board-reply-body">{r.body}</p>
          </li>
        ))}
        {post.replies.length === 0 && <li className="board-row-empty">아직 답변이 없습니다.</li>}
      </ul>

      {/* 닫힌 글에도 답변은 달 수 있다 — 닫았다고 대화가 끝나는 것은 아니다. */}
      <div className="board-reply-form">
        <textarea
          className="board-reply-input"
          rows={3}
          maxLength={MAX_BODY_CHARS}
          placeholder="답변을 적어 주세요. (Ctrl+Enter 로 올립니다)"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitChord(e)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={sending || !reply.trim()} onClick={() => void send()}>
          {sending ? "올리는 중…" : "답변 올리기"}
        </button>
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- 새 글 쓰기 */

interface ComposerProps {
  knownTags: string[];
  onCancel: () => void;
  onDone: (post: BoardPostView) => void;
  onError: (message: string) => void;
}

function Composer({ knownTags, onCancel, onDone, onError }: ComposerProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagText, setTagText] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  /** 쉼표로 가른다. 정리는 서버가 한 번 더 하므로 여기서는 보여 주기만 한다. */
  const typedTags = useMemo(
    () => [
      ...new Set(
        tagText
          .split(",")
          .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-").replace(/^#+/, ""))
          .filter(Boolean),
      ),
    ],
    [tagText],
  );
  const tags = typedTags.slice(0, MAX_TAGS);
  const dropped = typedTags.length - tags.length;

  const dirty = title.trim() !== "" || body.trim() !== "" || tagText.trim() !== "";

  /** 바깥을 눌렀든 Esc 를 눌렀든 여기를 지난다 — 적어 둔 것이 말없이 사라지지 않게. */
  function requestClose(): void {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  }

  function addTag(tag: string): void {
    if (tags.includes(tag) || tags.length >= MAX_TAGS) return;
    setTagText(tagText.trim() ? `${tagText.replace(/,\s*$/, "")}, ${tag}` : tag);
  }

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const created = await api.createBoardPost({ title: title.trim(), body: body.trim(), tags });
      onDone(created.post);
    } catch (err) {
      onError(messageOf(err));
      setSaving(false);
    }
  }

  return (
    <>
      <Modal title="새 문의" onClose={requestClose} width={560}>
        <div className="board-compose">
          <label className="board-field">
            <span className="board-field-label">제목</span>
            <input
              ref={titleRef}
              className="board-input"
              value={title}
              maxLength={MAX_TITLE_CHARS}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                // 한 줄짜리 칸에서 Enter 는 제출 말고 할 일이 없다.
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="무엇이 궁금한가요?"
            />
          </label>

          <label className="board-field">
            <span className="board-field-label">
              내용
              {body.length > MAX_BODY_CHARS * 0.9 && (
                <span className="board-field-count">
                  {body.length.toLocaleString()} / {MAX_BODY_CHARS.toLocaleString()}자
                </span>
              )}
            </span>
            <textarea
              className="board-input board-textarea"
              rows={7}
              maxLength={MAX_BODY_CHARS}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitChord(e)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="상황과 재현 방법을 적어 주시면 답하기 쉽습니다."
            />
          </label>

          <label className="board-field">
            <span className="board-field-label">태그 (쉼표로 구분, 최대 {MAX_TAGS}개)</span>
            <input
              className="board-input"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="예: 검색, 색인, 오류"
            />
          </label>

          {tags.length > 0 && (
            <div className="board-tagbar">
              {tags.map((t) => (
                <span key={t} className="board-badge">
                  #{t}
                </span>
              ))}
            </div>
          )}
          {/* 아홉 번째 태그를 조용히 버리지 않는다. */}
          {dropped > 0 && (
            <p className="board-field-warn">
              태그는 {MAX_TAGS}개까지입니다. 뒤의 {dropped}개는 빠집니다.
            </p>
          )}

          {knownTags.length > 0 && (
            <>
              <p className="board-field-label">이미 쓰이는 태그</p>
              <div className="board-tagbar">
                {knownTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="board-tag"
                    disabled={tags.length >= MAX_TAGS && !tags.includes(t)}
                    onClick={() => addTag(t)}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="board-compose-actions">
            <button type="button" className="btn btn-secondary" onClick={requestClose} disabled={saving}>
              취소
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={saving || !title.trim()}>
              {saving ? "올리는 중…" : "올리기"}
            </button>
          </div>
        </div>
      </Modal>

      {confirmDiscard && (
        <ConfirmDialog
          title="쓰던 글을 버릴까요?"
          message="적어 둔 내용이 사라집니다."
          confirmLabel="버리기"
          danger
          onConfirm={onCancel}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
