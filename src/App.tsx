import { useEffect, useRef, useState } from "react";
import { setMcpServerStatus } from "./api/client";
import { AdminPage } from "./components/AdminPage";
import { AuthScreen } from "./components/AuthScreen";
import { AppBackdrop } from "./components/AppBackdrop";
import { BrandMark } from "./components/BrandMark";
import { BoardPage } from "./components/BoardPage";
import { ConversationSettingsPage } from "./components/ConversationSettingsPage";
import { ChatView } from "./components/ChatView";
import { LibraryPage } from "./components/LibraryPage";
import { ToolsPage } from "./components/ToolsPage";
import { DocumentsPage } from "./components/DocumentsPage";
import { SharedConversationPage } from "./components/SharedConversationPage";
import { SourcePanel } from "./components/SourcePanel";
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
import { HASHES, shareTokenFromHash, viewFromHash } from "./routes";
import type { View } from "./routes";
import { loadUiPreferences } from "./state/storage";
import { StoreProvider, useStore } from "./state/StoreContext";
import "./App.css";

/**
 * 어디로 갈지는 주소가 정한다 — 규칙은 routes.ts 한 곳에 있다. 해시를 넣으면
 * `hashchange` 가 터지고, 그것은 브라우저의 뒤로·앞으로 버튼이 터뜨리는 것과
 * 같은 사건이다. 그래서 듣는 곳은 하나면 된다.
 */
function navigate(view: View): void {
  // Assigning the hash fires `hashchange`, which is also what the browser's
  // back/forward buttons fire — one listener covers both.
  window.location.hash = HASHES[view];
}

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
  const { ui, createConversation, session, conversationsLoading, activeConversationId, selectConversation } = useStore();
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
  useEffect(() => {
    if (creatingRef.current) return;
    if (!session || conversationsLoading || activeConversationId) return;
    creatingRef.current = true;
    void createConversation()
      .catch(() => {
        // Leave the empty state visible; the health banner explains the outage.
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [session, conversationsLoading, activeConversationId, createConversation]);

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
        onShowChat={() => navigate("chat")}
        onOpenAdmin={onOpenAdmin && (() => navigateFromDrawer("admin"))}
        onCloseDrawer={narrow ? () => setDrawerOpen(false) : undefined}
      />
      <main id="main" ref={mainRef} className="app-main" tabIndex={-1} inert={drawerModal}>
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
        {/* 대화 화면에서만. 다른 화면으로 가면 열려 있던 출처도 닫는다(아래 effect). */}
        {view === "chat" && <SourcePanel />}
      </main>
    </div>
  );
}
