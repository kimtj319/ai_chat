import { Suspense, useEffect, useRef, useState } from "react";
import { setMcpServerStatus } from "./api/client";
// 페이지들은 따로 받는다(lazyPages.tsx). 스타일만은 예전에 그 페이지를 부르던 자리에서
// 그대로 미리 싣는다 — 늦게 붙으면 glass.css(맨 마지막이어야 한다)보다 뒤에 놓여 그 규칙을
// 덮는다. 순서까지 같아 만들어지는 CSS 는 예전과 한 글자도 다르지 않다.
import "./components/ListSkeleton.css";
import "./components/Modal.css";
import "./components/ConfirmDialog.css";
import "./components/ModelEndpointDialog.css";
import "./components/Toast.css";
import "./components/PageHeader.css";
import "./components/AdminPage.css";
import { AuthScreen } from "./components/AuthScreen";
import { AppBackdrop } from "./components/AppBackdrop";
import { BrandMark } from "./components/BrandMark";
import "./components/MarkdownRenderer.css";
import "./components/BoardPage.css";
import "./components/ProhibitionsDialog.css";
import "./components/ConversationSettingsPage.css";
import { ChatView } from "./components/ChatView";
import "./components/Accordion.css";
import "./components/LibraryPage.css";
import "./components/MasterDetail.css";
import "./components/ToolsPage.css";
import "./components/DocumentViewer.css";
import "./components/DocumentsPage.css";
import { ListSkeleton } from "./components/ListSkeleton";
import { AdminPage, BoardPage, ConversationSettingsPage, DocumentsPage, LibraryPage, ToolsPage } from "./lazyPages";
import { SharedConversationPage } from "./components/SharedConversationPage";
import { SourcePanel } from "./components/SourcePanel";
import { clearSourceCache } from "./state/sourceCache";
import { closeSource, useOpenSource } from "./state/sourcePanel";
import { Sidebar } from "./components/Sidebar";
import { ToastHost } from "./components/Toast";
import { BrowserConfirmHost } from "./components/BrowserConfirmHost";
import { TooltipLayer } from "./components/TooltipLayer";
import { useAuth } from "./auth/AuthContext";
import { useChatStream } from "./hooks/useChatStream";
import { useScheduleRunner } from "./browser/scheduler";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDrawer } from "./hooks/useDrawer";
import { useScrollbarFade } from "./hooks/useScrollbarFade";
import { useTheme } from "./hooks/useTheme";
import { CHAT_HASH, HASHES, conversationHash, conversationIdFromHash, shareTokenFromHash, viewFromHash } from "./routes";
import type { View } from "./routes";
import { leaveVia } from "./state/leaveGuard";
import { loadUiPreferences } from "./state/storage";
import { StoreProvider, useStore } from "./state/StoreContext";
import { showToast } from "./components/Toast";
import "./App.css";

/**
 * 어디로 갈지는 주소가 정한다 — 규칙은 routes.ts 한 곳에 있다. 해시를 넣으면
 * `hashchange` 가 터지고, 그것은 브라우저의 뒤로·앞으로 버튼이 터뜨리는 것과
 * 같은 사건이다. 그래서 듣는 곳은 하나면 된다.
 */
function navigate(view: View): void {
  // 이미 그 화면이면 떠나는 것이 아니다 — 아래 확인을 묻지 않는다.
  if (window.location.hash === HASHES[view]) return;
  // Assigning the hash fires `hashchange`, which is also what the browser's
  // back/forward buttons fire — one listener covers both. 지금 화면에 떠나기 전
  // 확인이 걸려 있으면(적용하지 않은 대화 설정) 그것을 먼저 지난다.
  leaveVia(() => {
    window.location.hash = HASHES[view];
  });
}

/** 기록을 늘리지 않고 주소만 고친다. hashchange 가 나지 않고, 서랍이 남긴 history.state 도 그대로 둔다. */
function replaceHash(hash: string): void {
  window.history.replaceState(window.history.state, "", hash);
}

/** 탭 제목에 붙는 화면 이름. 대화 화면은 대화 제목을 쓴다. */
const VIEW_TITLES: Record<Exclude<View, "chat">, string> = {
  admin: "관리자",
  library: "커넥터",
  documents: "문서",
  board: "문의 게시판",
  tools: "도구 설정",
  settings: "대화 설정",
};

/** 이보다 좁은 창에서 출처 창을 열면 사이드바를 접는다 — 1280px 에서 대화 칸이 381px 까지 줄었다. */
const SOURCE_PANEL_ROOMY_WIDTH = 1500;

/** First paint, while `GET /api/auth/me` is still in flight. Deliberately not
 *  the chat shell: showing it and taking it away again is worse than waiting. */
function AuthSplash() {
  return (
    <div className="auth-splash" role="status">
      <BrandMark size={32} />
      <span>불러오는 중…</span>
    </div>
  );
}

export default function App() {
  const { status, isAdmin } = useAuth();
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));
  const [shareToken, setShareToken] = useState(() => shareTokenFromHash(window.location.hash));
  // Every scroll area in the app, including ones mounted long after this runs.
  useScrollbarFade();

  useEffect(() => {
    function handleHashChange() {
      setView(viewFromHash(window.location.hash));
      setShareToken(shareTokenFromHash(window.location.hash));
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // A shared /#/admin link opened by a non-administrator (or still open after
  // a role change) lands on the chat instead of an empty page. Signed-out
  // visitors keep the hash so the link still works once they log in.
  useEffect(() => {
    if (view === "admin" && status === "authenticated" && !isAdmin) navigate("chat");
  }, [view, status, isAdmin]);

  // 출처 창이 붙잡아 둔 문서는 계정의 것이다. 로그아웃(세션 만료 포함)하면 놓는다 —
  // 같은 탭에서 다른 계정으로 들어와 앞 사람의 문서를 보는 일이 없게.
  useEffect(() => {
    if (status === "anonymous") clearSourceCache();
  }, [status]);

  // 테마는 모든 화면 위에서, 어떤 조기 반환보다 먼저 건다.
  //
  // 예전에는 ChatShell 안에서만 걸었는데, 관리자 페이지는 그보다 앞서
  // 반환되므로 /admin 에서 새로고침하면 훅이 아예 실행되지 않았다. 그러면
  // <html> 에 data-theme 이 붙지 않고 CSS 가 기본값(다크)으로 떨어져,
  // 라이트를 골라 둔 사람이 관리자 화면만 어둡게 보게 된다.
  //
  // 취향은 localStorage 에 있으므로 스토어 없이도 읽힌다 — 그래서 로그인
  // 화면과 로딩 화면에도 같은 테마가 적용된다.
  useTheme(loadUiPreferences().theme);

  // 공유 링크는 로그인보다 앞에서 갈린다 — 받은 사람은 계정이 없을 수 있다. 로그인한
  // 사람이 열어도 같은 읽기 전용 화면이다(남의 대화를 제 대화 목록에 섞지 않는다).
  if (shareToken) {
    return (
      <>
        <SharedConversationPage token={shareToken} />
        <ToastHost />
        <TooltipLayer />
      </>
    );
  }

  if (status === "loading") return <AuthSplash />;
  if (status === "anonymous") return <AuthScreen />;

  // One host above every view, including the admin page, which returns before
  // the chat shell and would otherwise have nowhere to put a message.
  return (
    <>
      {/* Mounted only once signed in, so its bootstrap never fires against a
          session that does not exist — and unmounted on logout, which drops
          every conversation the previous user had loaded. Every page,
          the admin page included, swaps the body inside the shell and keeps
          the sidebar, so moving between them reads as one app. */}
      <StoreProvider>
        <ChatShell
          view={view === "admin" && !isAdmin ? "chat" : view}
          onOpenAdmin={isAdmin ? () => navigate("admin") : null}
          onAdminSetMcpStatus={isAdmin ? setMcpServerStatus : null}
        />
      </StoreProvider>
      <BrowserConfirmHost />
      <ToastHost />
      <TooltipLayer />
    </>
  );
}

/** 삼선. 서랍이 열려 있는 동안은 이 단추가 없고 서랍 안의 닫기 단추를 쓴다. */
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

interface ChatShellProps {
  view: View;
  /** Null for a non-administrator, which hides the row rather than disabling it. */
  onOpenAdmin: (() => void) | null;
  /** Same convention, for the library page's per-server admin control. */
  onAdminSetMcpStatus: ((id: string, disabled: boolean) => Promise<void>) | null;
}

function ChatShell({ view, onOpenAdmin, onAdminSetMcpStatus }: ChatShellProps) {
  const {
    ui,
    createConversation,
    session,
    conversations,
    conversationsLoading,
    conversationsError,
    activeConversationId,
    selectConversation,
    setSidebarCollapsed,
  } = useStore();
  const chatStream = useChatStream();
  // 예약 작업: 시각이 되면 그 대화를 열고 지시를 보낸다(browser/scheduler.ts).
  useScheduleRunner({ isStreaming: chatStream.isStreaming, sendMessage: chatStream.sendMessage, selectConversation });

  // On a fresh load (or a hard refresh) nothing is selected, which used to
  // show a "선택된 대화가 없습니다" placeholder. Open a conversation
  // automatically instead, so arriving at the app looks exactly like pressing
  // 새 대화. Guarded by a ref so React 18's double-invoked effects — and any
  // later re-render — can't create a second empty conversation.
  // Also covers deleting the open conversation: the selection clears, so this
  // immediately opens a fresh one instead of falling back to the
  // "선택된 대화가 없습니다" placeholder.
  const creatingRef = useRef(false);

  // 주소의 대화(#/c/<id>). 처음 열 때와 주소가 바뀔 때(뒤로·앞으로·붙여 넣은 링크)마다
  // "열어 달라" 는 요청으로 남겨 두고, 목록이 온 뒤에 한 번 처리한다. 목록이 바뀔 때마다
  // 주소를 다시 읽지 않는 것이 요점이다 — 열린 대화를 지운 순간 주소에는 아직 그 id 가
  // 남아 있는데, 그것을 "없는 대화로 들어왔다" 로 읽으면 엉뚱한 안내가 뜬다.
  const pendingLinkRef = useRef<string | null>(conversationIdFromHash(window.location.hash));
  /** 열어 달라고 이미 부른 대화(selectConversation). */
  const requestedLinkRef = useRef<string | null>(null);
  const [linkRequest, setLinkRequest] = useState(0);
  useEffect(() => {
    function onHashChange() {
      pendingLinkRef.current = conversationIdFromHash(window.location.hash);
      setLinkRequest((n) => n + 1);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  useEffect(() => {
    if (creatingRef.current) return;
    if (!session || conversationsLoading) return;
    const openNew = () => {
      creatingRef.current = true;
      void createConversation()
        .catch(() => {
          // Leave the empty state visible; the health banner explains the outage.
        })
        .finally(() => {
          creatingRef.current = false;
        });
    };
    const linked = pendingLinkRef.current;
    if (linked !== null && linked === activeConversationId) {
      pendingLinkRef.current = null;
      requestedLinkRef.current = null;
      return;
    }
    if (linked !== null && requestedLinkRef.current === linked) {
      // 부른 사이 다른 대화가 열렸다 — 그쪽이 이긴다. 요청은 버리고 평소처럼 처리한다.
      pendingLinkRef.current = null;
      requestedLinkRef.current = null;
    } else if (linked !== null) {
      // 목록을 못 받았으면 있는지 없는지 모른다. 그냥 열어 보고, 못 열면 대화 화면이 그 오류를 말한다.
      if (conversationsError || conversationsRef.current.some((c) => c.id === linked)) {
        // 요청(pendingLinkRef)은 그 대화가 실제로 열릴 때(다음 그림)까지 쥐고 있는다. 아래
        // "주소 맞추기" 가 그동안 옛 대화를 보고 주소를 되돌리지 않게 — 뒤로 가기가 먹지 않던 원인.
        requestedLinkRef.current = linked;
        void selectConversation(linked);
        return;
      }
      // 지워졌거나 남의 것이거나 잘못 옮겨 적은 주소. 빈 화면 대신 새 대화로 받고 그렇다고 말한다.
      pendingLinkRef.current = null;
      showToast("대화를 찾을 수 없어 새 대화를 열었습니다.");
      replaceHash(CHAT_HASH);
      const activeIsListed = conversationsRef.current.some((c) => c.id === activeConversationId);
      if (!activeConversationId || activeIsListed) openNew();
      return;
    }
    if (activeConversationId) return;
    openNew();
  }, [session, conversationsLoading, conversationsError, activeConversationId, createConversation, selectConversation, linkRequest]);

  // 열린 대화를 주소에 싣는다. 목록에 있는 대화(메시지가 있는 것)만 — 빈 새 대화는 #/ 다.
  // 다른 대화에서 옮겨 온 것이면 기록을 하나 늘려 뒤로 가기가 그 대화로 돌아가게 하고,
  // 그 밖(첫 화면·지운 대화·첫 메시지로 목록에 막 오른 대화)은 지금 기록을 고친다.
  const activeListed = activeConversationId !== null && conversations.some((c) => c.id === activeConversationId);
  useEffect(() => {
    if (view !== "chat" || pendingLinkRef.current !== null || !activeConversationId) return;
    const want = activeListed ? conversationHash(activeConversationId) : CHAT_HASH;
    const hash = window.location.hash;
    if (hash === want || (want === CHAT_HASH && hash === "")) return;
    const fromId = conversationIdFromHash(hash);
    if (fromId !== null && conversationsRef.current.some((c) => c.id === fromId)) window.location.hash = want;
    else replaceHash(want);
    // linkRequest: 열린 대화의 줄을 다시 누르면 navigate("chat") 이 주소를 #/ 로 바꾸는데,
    // 열린 대화는 그대로라 위 셋만으로는 다시 돌지 않는다.
  }, [view, activeConversationId, activeListed, linkRequest]);

  // 탭·방문 기록 목록에서 화면을 가려 볼 수 있게. 대화 화면은 그 대화의 제목.
  const activeTitle = conversations.find((c) => c.id === activeConversationId)?.title;
  useEffect(() => {
    const name = view === "chat" ? activeTitle || "새 대화" : VIEW_TITLES[view];
    document.title = `${name} · AI Console`;
  }, [view, activeTitle]);

  const { narrow, drawerOpen, setDrawerOpen, drawerModal, drawerToggleRef, shellRef, navigateFromDrawer } = useDrawer({
    view,
    activeConversationId,
    sidebarCollapsed: ui.sidebarCollapsed,
    navigate,
  });
  const mainRef = useRef<HTMLElement>(null);
  const showLibrary = view === "library";
  const showDocuments = view === "documents";
  const showBoard = view === "board";
  // `view` is already "chat" for a non-administrator on #/admin (App coerces it).
  const showAdmin = view === "admin";
  const showTools = view === "tools";
  const showSettings = view === "settings";

  const sourceOpen = useOpenSource() !== null;
  useEffect(() => {
    if (view !== "chat") closeSource();
  }, [view]);

  // 좁은 창에서 출처 창이 열리면 사이드바를 접어 대화 칸을 돌려주고, 닫으면 되살린다.
  // 열려 있는 동안 사람이 직접 펼쳤다면 그 선택이 이긴다 — 닫을 때 건드리지 않는다.
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (sourceOpen) {
      if (!narrow && !ui.sidebarCollapsed && window.innerWidth < SOURCE_PANEL_ROOMY_WIDTH) {
        autoCollapsedRef.current = true;
        setSidebarCollapsed(true);
      }
    } else if (autoCollapsedRef.current) {
      autoCollapsedRef.current = false;
      setSidebarCollapsed(false);
    }
    // 여는·닫는 순간에만 판단한다. 접힘 상태가 바뀔 때 다시 돌면 사람이 펼친 것을 도로 접는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceOpen]);
  useEffect(() => {
    if (!ui.sidebarCollapsed) autoCollapsedRef.current = false;
  }, [ui.sidebarCollapsed]);

  useTheme(ui.theme);
  // 새 대화는 어느 화면에서 눌러도 채팅으로 돌아와 연다 — 라이브러리를 보던 중에 대화만
  // 만들어지고 화면은 그대로이면 무엇이 일어났는지 보이지 않는다.
  useKeyboardShortcuts({
    onNewConversation: () => {
      navigate("chat");
      void createConversation();
    },
    onStop: chatStream.stopGeneration,
  });

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-narrow={narrow || undefined}
      data-drawer-open={drawerOpen || undefined}
      data-source-open={sourceOpen || undefined}
    >
      {/* 키보드로 들어오면 처음 닿는 것. 사이드바 목록을 다 지나지 않고 본문으로 간다.
          href 는 보조 기술에 링크로 읽히게 하려는 것이고, 실제 이동은 onClick 이 한다 —
          해시를 바꾸면 라우터(routes.ts)가 그것을 화면 주소로 읽는다. */}
      <a
        href="#main"
        className="skip-link"
        inert={drawerModal}
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        본문으로 건너뛰기
      </a>

      <AppBackdrop />

      {/* 서랍이 열려 있는 동안은 서랍 안의 닫기 단추(로고 줄)를 쓴다. */}
      {narrow && !drawerOpen && (
        <button
          ref={drawerToggleRef}
          type="button"
          className="btn-icon app-drawer-toggle"
          aria-label="메뉴 열기"
          aria-expanded={false}
          data-tooltip="메뉴 열기"
          onClick={() => setDrawerOpen(true)}
        >
          <MenuIcon />
        </button>
      )}

      {narrow && drawerOpen && (
        // 버튼으로 둔다: 뒤를 덮는 일만 하는 것이 아니라, 닫는 가장 큰 표적이다.
        // Tab 차례에서는 뺀다 — 서랍 안의 닫기 단추와 Esc 가 키보드의 길이다.
        <button type="button" className="app-scrim" aria-label="메뉴 닫기" tabIndex={-1} onClick={() => setDrawerOpen(false)} />
      )}

      <Sidebar
        view={view}
        onOpenConversationSettings={() => navigateFromDrawer("settings")}
        onOpenToolsPanel={() => navigateFromDrawer("tools")}
        onOpenLibrary={() => navigateFromDrawer("library")}
        onOpenDocuments={() => navigateFromDrawer("documents")}
        onOpenBoard={() => navigateFromDrawer("board")}
        onShowChat={() => navigate("chat")}
        onOpenAdmin={onOpenAdmin && (() => navigateFromDrawer("admin"))}
        onCloseDrawer={narrow ? () => setDrawerOpen(false) : undefined}
      />
      <main id="main" ref={mainRef} className="app-main" tabIndex={-1} inert={drawerModal}>
        <Suspense fallback={<ListSkeleton />}>
        {showAdmin ? (
          <AdminPage onBack={() => navigate("chat")} />
        ) : showTools ? (
          <ToolsPage onBack={() => navigate("chat")} />
        ) : showSettings ? (
          <ConversationSettingsPage onBack={() => navigate("chat")} />
        ) : showLibrary ? (
          <LibraryPage onBack={() => navigate("chat")} onAdminSetStatus={onAdminSetMcpStatus} />
        ) : showDocuments ? (
          <DocumentsPage onBack={() => navigate("chat")} />
        ) : showBoard ? (
          <BoardPage onBack={() => navigate("chat")} />
        ) : (
          <ChatView
            chatStream={chatStream}
            onOpenLibrary={() => navigate("library")}
            onOpenTools={() => navigate("tools")}
            onOpenBoard={() => navigate("board")}
          />
        )}
        </Suspense>
        {/* 대화 화면에서만. 다른 화면으로 가면 열려 있던 출처도 닫는다(아래 effect). */}
        {view === "chat" && <SourcePanel />}
      </main>
    </div>
  );
}
