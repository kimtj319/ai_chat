import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/client";
import type { BoardPostStatus, BoardPostSummary, BoardPostView } from "../api/types";
import { BOARD_HASH, boardPostHash, boardPostIdFromHash } from "../routes";
import { cachedBoardList, loadBoardList } from "../state/boardCache";
import { exactTime, hueOf, relativeTime } from "../state/boardFormat";
import { errorMessage, isNotFoundError } from "../state/friendlyError";
import { BoardComposer } from "./BoardComposer";
import { PostDetail } from "./BoardPost";
import { CommentIcon, Label, ListBackIcon, nameOf, ref, SearchIcon, StatusIcon } from "./boardParts";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState, ListSkeleton, LoadFailed } from "./ListSkeleton";
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
  /** 고치는 중인 글. 새 글 쓰기와 같은 창을 그 글의 내용으로 연다. */
  const [editing, setEditing] = useState<BoardPostView | null>(null);
  const [confirming, setConfirming] = useState<BoardPostView | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  /** 우리가 밀어 넣은 글 주소의 id — 뒤로 버튼이 history 를 되감아도 되는지 가른다.
   *  참/거짓이 아니라 id 인 이유: 글 안의 링크로 다른 글로 옮겨 가면 되감을 곳이
   *  목록이 아니라 앞 글이다. 지금 보는 글이 우리가 넣은 그 글일 때만 되감는다. */
  const pushedRef = useRef<string | null>(null);

  /* ------------------------------------------------------------ 주소 ↔ 화면 */

  useEffect(() => {
    const sync = () => setPostId(boardPostIdFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function showPost(id: string): void {
    pushedRef.current = id;
    window.location.hash = boardPostHash(id);
  }

  function showList(): void {
    // 우리가 밀어 넣은 주소면 되감는다. 새 주소를 또 쌓으면 브라우저 뒤로가
    // 방금 빠져나온 글로 되돌아가 버린다.
    if (pushedRef.current !== null && pushedRef.current === postId) {
      pushedRef.current = null;
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
      // 목록으로 돌아왔다(브라우저 뒤로도). 밀어 넣은 주소는 이제 되감을 것이 아니다.
      pushedRef.current = null;
      setPost(null);
      return;
    }
    // 다른 글로 옮겨 가면 앞 글을 내린다 — 그대로 두면 새 글이 오기 전까지 앞 글이
    // 보이고, 그 아래 답변 칸이 새 글에 답을 올린다.
    setPost((current) => (current?.id === postId ? current : null));
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
        // 없는 글(지워졌거나 주소가 틀림)은 아래 빈 자리가 말한다. 위 배너까지 띄우면 같은 말을 두 번 한다.
        if (!isNotFoundError(err)) setError(errorMessage(err));
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
      setError(errorMessage(err));
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
      // 목록으로 돌아오기만 하면 지워졌는지 알 수 없다.
      showToast(`${ref(target.number)} 문의를 삭제했습니다.`.trim());
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
              // 글마다 새로: 쓰던 답변이 다른 글로 따라가지 않는다.
              key={post.id}
              post={post}
              busy={busy}
              onStatus={changeStatus}
              onEdit={() => setEditing(post)}
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
              <EmptyState
                title="글을 열 수 없습니다"
                reason="지워졌거나 주소가 잘못되었을 수 있습니다."
                actionLabel="목록으로"
                onAction={showList}
              />
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
        <BoardComposer
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

      {editing && (
        <BoardComposer
          editing={editing}
          knownTags={knownTags}
          onCancel={() => setEditing(null)}
          onDone={(updated) => {
            setEditing(null);
            setPost(updated);
            void reload();
            showToast(`${ref(updated.number)} 글을 고쳤습니다.`.trim());
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
