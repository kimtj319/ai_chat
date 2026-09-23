import { useEffect, useRef, useState } from "react";
import { setMcpServerStatus } from "./api/client";
import { AdminPage } from "./components/AdminPage";
import { AuthScreen } from "./components/AuthScreen";
import { AppBackdrop } from "./components/AppBackdrop";
import { BrandMark } from "./components/BrandMark";
import { BoardPage } from "./components/BoardPage";
import { ChatView } from "./components/ChatView";
import { LibraryPage } from "./components/LibraryPage";
import { DocumentsPage } from "./components/DocumentsPage";
import { SourcePanel } from "./components/SourcePanel";
import { closeSource, useOpenSource } from "./state/sourcePanel";
import { Sidebar } from "./components/Sidebar";
import { ToastHost } from "./components/Toast";
import { TooltipLayer } from "./components/TooltipLayer";
import { useAuth } from "./auth/AuthContext";
import { useChatStream } from "./hooks/useChatStream";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useScrollbarFade } from "./hooks/useScrollbarFade";
import { useTheme } from "./hooks/useTheme";
import { HASHES, viewFromHash } from "./routes";
import { pushOverlay } from "./ui/overlayStack";
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
  // Every scroll area in the app, including ones mounted long after this runs.
  useScrollbarFade();

  useEffect(() => {
    function handleHashChange() {
      setView(viewFromHash(window.location.hash));
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

  if (status === "loading") return <AuthSplash />;
  if (status === "anonymous") return <AuthScreen />;

  // One host above every view, including the admin page, which returns before
  // the chat shell and would otherwise have nowhere to put a message.
  return (
    <>
      {view === "admin" && isAdmin ? (
        <AdminPage onBack={() => navigate("chat")} />
      ) : (
        // Mounted only once signed in, so its bootstrap never fires against a
        // session that does not exist — and unmounted on logout, which drops
        // every conversation the previous user had loaded.
        <StoreProvider>
          {/* The library keeps the sidebar, so unlike the admin page it swaps
              the body inside the shell rather than replacing it. */}
          <ChatShell
            view={view}
            onOpenAdmin={isAdmin ? () => navigate("admin") : null}
            onAdminSetMcpStatus={isAdmin ? setMcpServerStatus : null}
          />
        </StoreProvider>
      )}
      <ToastHost />
      <TooltipLayer />
    </>
  );
}

/** 열려 있으면 X, 닫혀 있으면 삼선 — 버튼 하나가 두 가지 일을 하므로 모양도 둘이다. */
function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
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
  const { ui, createConversation, session, conversationsLoading, activeConversationId } = useStore();
  const chatStream = useChatStream();

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

  // Panel-open flags live here (rather than inside ChatView) purely so the
  // sidebar's icon-nav rows can trigger and reflect them too — no store/logic
  // change, just where this presentational on/off state is held.
  const [showConversationSettings, setShowConversationSettings] = useState(false);
  const [showToolsPanel, setShowToolsPanel] = useState(false);

  // 좁은 화면에서는 사이드바가 붙박이 칸을 그만두고 떠 있는 서랍이 된다.
  // 기준점은 CSS 와 같은 1024px 이다 — 여기서 구조가 바뀌고(스크림·Esc·자동
  // 닫기), 저기서 모양이 바뀐다.
  const narrow = useMediaQuery("(max-width: 1024px)");
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 서랍은 무엇을 고르면 닫힌다. 무엇을 골랐는지는 주소와 열린 대화가 말해 주므로
  // 사이드바 안의 버튼 하나하나에 손을 댈 필요가 없다 — 설정 팝오버처럼
  // 화면을 옮기지 않는 것을 눌렀을 때 서랍이 닫히지 않는 것도 같은 이유다.
  useEffect(() => {
    setDrawerOpen(false);
  }, [view, activeConversationId]);

  // 창을 넓히면 서랍이라는 개념 자체가 사라진다. 열린 채로 두면 넓은 화면에
  // 쓸모없는 스크림만 남는다.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  // 열려 있는 동안은 Esc 가 서랍의 몫이다 — 생성 중단과 겹치지 않게.
  useEffect(() => (drawerOpen ? pushOverlay() : undefined), [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);
  const showLibrary = view === "library";
  const showDocuments = view === "documents";
  const showBoard = view === "board";

  const sourceOpen = useOpenSource() !== null;
  useEffect(() => {
    if (view !== "chat") closeSource();
  }, [view]);

  useTheme(ui.theme);
  useKeyboardShortcuts({ onNewConversation: () => void createConversation(), onStop: chatStream.stopGeneration });

  return (
    <div
      className="app-shell"
      data-narrow={narrow || undefined}
      data-drawer-open={drawerOpen || undefined}
      data-source-open={sourceOpen || undefined}
    >
      <AppBackdrop />

      {narrow && (
        <button
          type="button"
          className="btn-icon app-drawer-toggle"
          aria-label={drawerOpen ? "메뉴 닫기" : "메뉴 열기"}
          aria-expanded={drawerOpen}
          data-tooltip={drawerOpen ? "메뉴 닫기" : "메뉴 열기"}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <MenuIcon open={drawerOpen} />
        </button>
      )}

      {narrow && drawerOpen && (
        // 버튼으로 둔다: 뒤를 덮는 일만 하는 것이 아니라, 닫는 가장 큰 표적이다.
        <button type="button" className="app-scrim" aria-label="메뉴 닫기" onClick={() => setDrawerOpen(false)} />
      )}

      <Sidebar
        conversationSettingsOpen={showConversationSettings}
        toolsPanelOpen={showToolsPanel}
        libraryOpen={showLibrary}
        documentsOpen={showDocuments}
        boardOpen={showBoard}
        // Both panels live in ChatView, so opening one has to bring the chat
        // back with it when the library is the thing on screen.
        onOpenConversationSettings={() => {
          navigate("chat");
          setShowConversationSettings(true);
        }}
        onOpenToolsPanel={() => {
          navigate("chat");
          setShowToolsPanel(true);
        }}
        onOpenLibrary={() => navigate("library")}
        onOpenDocuments={() => navigate("documents")}
        onShowChat={() => navigate("chat")}
        onOpenAdmin={onOpenAdmin}
      />
      {showLibrary ? (
        <LibraryPage onBack={() => navigate("chat")} onAdminSetStatus={onAdminSetMcpStatus} />
      ) : showDocuments ? (
        <DocumentsPage onBack={() => navigate("chat")} />
      ) : showBoard ? (
        <BoardPage onBack={() => navigate("chat")} />
      ) : (
        <ChatView
          chatStream={chatStream}
          onOpenAdmin={onOpenAdmin}
          showConversationSettings={showConversationSettings}
          showToolsPanel={showToolsPanel}
          onCloseConversationSettings={() => setShowConversationSettings(false)}
          onCloseToolsPanel={() => setShowToolsPanel(false)}
          onOpenLibrary={() => navigate("library")}
          onOpenBoard={() => navigate("board")}
        />
      )}
      {/* 대화 화면에서만. 다른 화면으로 가면 열려 있던 출처도 닫는다(아래 effect). */}
      {!showLibrary && !showDocuments && !showBoard && <SourcePanel />}
    </div>
  );
}
