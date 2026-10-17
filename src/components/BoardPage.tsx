import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/client";
import type { BoardPostStatus, BoardPostSummary, BoardPostView } from "../api/types";
import { BOARD_HASH, boardPostHash, boardPostIdFromHash } from "../routes";
import { cachedBoardList, loadBoardList } from "../state/boardCache";
import { exactTime, hueOf, initialOf, participantsOf, relativeTime, timelineOf } from "../state/boardFormat";
import { copyText } from "../state/clipboard";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState, ListSkeleton, LoadFailed } from "./ListSkeleton";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { Modal } from "./Modal";
import { PageHeader } from "./PageHeader";
import { showToast } from "./Toast";
import "./BoardPage.css";

/**
 * 문의 게시판.
 *
 * GitLab 이슈 화면의 모양을 그대로 빌렸다 — 번호(#12)·상태 아이콘·색 라벨·
 * 답변 수가 한 줄에 놓인 목록, 글에서는 본문·활동 타임라인·오른쪽 정보 패널.
 * 사내 사람들이 이미 매일 읽는 화면이라 따로 배울 것이 없다: 내 문제가 이미
 * 올라와 있는지 훑고, 없으면 올리고, 답이 달리면 닫는다.
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

type Tab = BoardPostStatus | "all";
type Sort = "updated" | "created";

/** 화면에서도 막아 둔다. 서버가 잘라 내기 전에 사람이 먼저 알아야 한다. */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 20_000;
const MAX_TAGS = 8;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 계정 이름이 있으면 이름, 없으면 id — 없는 이름을 지어내지 않는다. */
function nameOf(name: string | null, id: string): string {
  return name || id;
}

const ref = (n: number | undefined) => (n ? `#${n}` : "");

/** 여러 줄 입력에서의 제출. Enter 는 줄바꿈으로 남겨 둬야 하므로 수식키를 쓴다. */
function isSubmitChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

export function BoardPage({ onBack }: Props) {
  // The last list seen draws at once; reload() refreshes it underneath.
  const [posts, setPosts] = useState<BoardPostSummary[]>(() => cachedBoardList()?.posts ?? []);
  const [knownTags, setKnownTags] = useState<string[]>(() => cachedBoardList()?.tags ?? []);
  const [tab, setTab] = useState<Tab>("open");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [listLoading, setListLoading] = useState(() => cachedBoardList() === null);
  /** 목록을 가져오지 못했다. 보여 줄 지난 목록이 없으면 목록 자리에 그린다. */
  const [listFailed, setListFailed] = useState(false);
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
    setListLoading(cachedBoardList() === null);
    try {
      const body = await loadBoardList();
      setPosts(body.posts);
      setKnownTags(body.tags);
      setListFailed(false);
    } catch {
      setListFailed(true);
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
  // 검색어도 같다. "#12" 처럼 번호로도 찾는다 — 사람들은 번호로 부른다.
  const inScope = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byNumber = /^#?\d+$/.test(q) ? Number(q.replace("#", "")) : null;
    return posts.filter(
      (p) =>
        (!tagFilter || p.tags.includes(tagFilter)) &&
        (!q || p.number === byNumber || p.title.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q))),
    );
  }, [posts, tagFilter, query]);

  const counts = useMemo(
    () => ({
      open: inScope.filter((p) => p.status === "open").length,
      closed: inScope.filter((p) => p.status === "closed").length,
      all: inScope.length,
    }),
    [inScope],
  );

  const visible = useMemo(() => {
    const field = sort === "updated" ? "updatedAt" : "createdAt";
    return inScope
      .filter((p) => tab === "all" || p.status === tab)
      .sort((a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0));
  }, [inScope, tab, sort]);

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
      showToast(status === "closed" ? `${ref(target.number)} 문의를 닫았습니다.` : `${ref(target.number)} 문의를 다시 열었습니다.`);
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
      {/* 뒤로 단추는 늘 대화로 간다(서랍 화면에서는 숨는다). 글에서 목록으로 가는
          길은 본문 맨 위의 "목록으로" 다 — 둘은 다른 일이라 한 단추에 겹치지 않는다. */}
      <PageHeader
        title="문의 게시판"
        onBack={onBack}
        subtitle={onDetail ? "질문·요청·결함을 남기면 담당자가 답합니다" : `열림 ${counts.open}개 · 닫힘 ${counts.closed}개`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setComposing(true)} disabled={busy}>
            새 문의
          </button>
        }
      />

      <div className="board-body" ref={bodyRef}>
        {error && (
          <p className="board-error" role="alert">
            {error}
            <button type="button" className="board-banner-close" onClick={() => setError(null)} aria-label="닫기">
              ×
            </button>
          </p>
        )}

        {onDetail && (
          // GitLab 의 빵부스러기: 어디에 있는지 말하고, 앞 칸을 누르면 목록으로 간다.
          <nav className="board-crumbs" aria-label="위치">
            <button type="button" className="board-crumb" onClick={showList}>
              <ListBackIcon />
              문의 게시판
            </button>
            <span className="board-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="board-crumb-here">{post ? ref(post.number) || "글" : "…"}</span>
          </nav>
        )}

        {listFailed && posts.length > 0 && !onDetail && (
          <p className="board-error" role="alert">
            문의 목록을 새로 불러오지 못했습니다.
            <button type="button" className="btn btn-sm board-banner-retry" onClick={() => void reload()}>
              다시 시도
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
            <div className="board-toolbar">
              <div className="board-tabs" role="tablist" aria-label="상태">
                {(["open", "closed", "all"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className="board-tab"
                    data-selected={tab === t || undefined}
                    onClick={() => setTab(t)}
                  >
                    {t !== "all" && <StatusIcon status={t} />}
                    {t === "open" ? "열림" : t === "closed" ? "닫힘" : "전체"}
                    <span className="board-tab-count">{counts[t]}</span>
                  </button>
                ))}
              </div>
              <div className="board-toolbar-right">
                <label className="board-search">
                  <SearchIcon />
                  <input
                    id="board-search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="제목·라벨·#번호로 찾기"
                    aria-label="문의 찾기"
                  />
                </label>
                <select
                  id="board-sort"
                  className="board-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as Sort)}
                  aria-label="정렬"
                >
                  <option value="updated">최근 활동순</option>
                  <option value="created">최근 작성순</option>
                </select>
              </div>
            </div>

            {knownTags.length > 0 && (
              <div className="board-tagbar" aria-label="라벨로 거르기">
                {knownTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="board-label board-label-filter"
                    style={{ "--label-hue": hueOf(t) } as React.CSSProperties}
                    aria-pressed={tagFilter === t}
                    data-selected={tagFilter === t || undefined}
                    onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  >
                    {t}
                  </button>
                ))}
                {tagFilter && (
                  <button type="button" className="board-tag-clear" onClick={() => setTagFilter(null)}>
                    라벨 해제
                  </button>
                )}
              </div>
            )}

            <ul className="board-list">
              {/* 불러오는 동안 빈 화면을 보여 주면, 글이 없는 것인지 아직 안 온
                  것인지 구분할 수 없다. */}
              {listLoading && posts.length === 0 && (
                <li className="board-row-loading">
                  <ListSkeleton rows={4} />
                </li>
              )}
              {listFailed && !listLoading && posts.length === 0 && (
                <li className="board-row-empty">
                  <LoadFailed message="문의 목록을 불러오지 못했습니다." onRetry={() => void reload()} />
                </li>
              )}

              {visible.map((summary) => (
                <li key={summary.id} className="board-row" data-status={summary.status}>
                  <StatusIcon status={summary.status} />
                  <div className="board-row-main">
                    <div className="board-row-line">
                      <button type="button" className="board-row-title" onClick={() => showPost(summary.id)}>
                        {summary.title}
                      </button>
                      {summary.tags.map((t) => (
                        <Label key={t} name={t} />
                      ))}
                    </div>
                    <p className="board-row-meta">
                      {ref(summary.number)}
                      {summary.number ? " · " : ""}
                      <span title={exactTime(summary.createdAt)}>{relativeTime(summary.createdAt)}</span>{" "}
                      {nameOf(summary.authorName, summary.authorId)} 님이 작성
                    </p>
                  </div>
                  <div className="board-row-side">
                    <span
                      className="board-row-comments"
                      data-zero={summary.replyCount === 0 || undefined}
                      aria-label={`답변 ${summary.replyCount}개`}
                    >
                      <CommentIcon />
                      {summary.replyCount}
                    </span>
                    <span className="board-row-updated" title={exactTime(summary.updatedAt)}>
                      {relativeTime(summary.updatedAt)} 업데이트
                    </span>
                  </div>
                </li>
              ))}

              {visible.length === 0 && !listLoading && !(listFailed && posts.length === 0) && (
                <li className="board-row-empty">
                  {query.trim() || tagFilter ? (
                    "조건에 맞는 문의가 없습니다."
                  ) : tab !== "closed" ? (
                    <EmptyState
                      title="열린 문의가 없습니다"
                      reason="사용 중 막히거나 바라는 기능이 있으면 남겨 주세요. 담당자가 이곳에 답합니다."
                      actionLabel="새 문의"
                      onAction={() => setComposing(true)}
                      actionDisabled={busy}
                    />
                  ) : (
                    "닫힌 문의가 없습니다."
                  )}
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
          title="문의를 삭제할까요?"
          message={`"${confirming.title}" 글과 달린 답변이 함께 삭제됩니다. 되돌릴 수 없습니다.`}
          confirmLabel="삭제"
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
  onStatus: (post: BoardPostView, status: BoardPostStatus) => Promise<void>;
  onDelete: () => void;
  onReplied: (post: BoardPostView) => void;
  onError: (message: string) => void;
}

function PostDetail({ post, busy, onStatus, onDelete, onReplied, onError }: DetailProps) {
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
      onError(messageOf(err));
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
            <NoteHead name={post.authorName} id={post.authorId} at={post.createdAt} isAuthor={false} />
            <div className="board-note-body">
              {post.body ? <MarkdownRenderer content={post.body} /> : <p className="board-note-empty">설명이 없습니다.</p>}
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
                  <div className="board-note">
                    <NoteHead
                      name={item.reply.authorName}
                      id={item.reply.authorId}
                      at={item.reply.createdAt}
                      isAuthor={item.reply.authorId === post.authorId}
                    />
                    <div className="board-note-body">
                      <MarkdownRenderer content={item.reply.body} />
                    </div>
                  </div>
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
            <textarea
              id="board-reply"
              className="board-reply-input"
              rows={4}
              maxLength={MAX_BODY_CHARS}
              placeholder="답변을 적어 주세요. 마크다운을 쓸 수 있습니다."
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

/* ------------------------------------------------------------- 작은 조각들 */

function NoteHead({ name, id, at, isAuthor }: { name: string | null; id: string; at: string; isAuthor: boolean }) {
  return (
    <header className="board-note-head">
      <strong>{nameOf(name, id)}</strong>
      <span className="board-note-handle">@{id}</span>
      <span className="board-note-time" title={exactTime(at)}>
        · {relativeTime(at)}
      </span>
      {isAuthor && <span className="board-note-role">작성자</span>}
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

function Label({ name }: { name: string }) {
  return (
    <span className="board-label" style={{ "--label-hue": hueOf(name) } as React.CSSProperties}>
      {name}
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

/** GitLab 의 열림(빈 원 안의 점)·닫힘(체크) 아이콘. 색이 아닌 모양으로도 가른다. */
function StatusIcon({ status }: { status: BoardPostStatus }) {
  return (
    <svg className="board-status-icon" data-status={status} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {status === "open" ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.4 8.2l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3 3" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 9.5l3-3" />
      <path d="M7 4.5l1-1a2.8 2.8 0 014 4l-1 1" />
      <path d="M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1" />
    </svg>
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
              placeholder="상황과 재현 방법을 적어 주시면 답하기 쉽습니다. 마크다운을 쓸 수 있습니다."
            />
          </label>

          <label className="board-field">
            <span className="board-field-label">라벨 (쉼표로 구분, 최대 {MAX_TAGS}개)</span>
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
                <Label key={t} name={t} />
              ))}
            </div>
          )}
          {/* 아홉 번째 태그를 조용히 버리지 않는다. */}
          {dropped > 0 && (
            <p className="board-field-warn">
              라벨은 {MAX_TAGS}개까지입니다. 뒤의 {dropped}개는 빠집니다.
            </p>
          )}

          {knownTags.length > 0 && (
            <>
              <p className="board-field-label">이미 쓰이는 라벨</p>
              <div className="board-tagbar">
                {knownTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="board-label board-label-filter"
                    style={{ "--label-hue": hueOf(t) } as React.CSSProperties}
                    disabled={tags.length >= MAX_TAGS && !tags.includes(t)}
                    onClick={() => addTag(t)}
                  >
                    {t}
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

function ListBackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
