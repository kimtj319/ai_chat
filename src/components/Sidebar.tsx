import { Fragment, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { patchConversation } from "../api/client";
import { useDismiss } from "../hooks/useDismiss";
import { useModels } from "../hooks/useModels";
import type { View } from "../routes";
import { endpointLabel, resolveSelectedModelId } from "../state/modelCatalog";
import { parseImportedConversations } from "../state/exportImport";
import { filterByTitle, groupConversationsByDate } from "../state/conversationGroups";
import { useGeneratingConversationIds } from "../state/generatingConversations";
import { useStore, useActiveConversation } from "../state/StoreContext";
import { BRAND_WORDMARK, BrandMark } from "./BrandMark";
import { ConfirmDialog } from "./ConfirmDialog";
import { ConversationRow } from "./ConversationRow";
import { showErrorToast, showToast } from "./Toast";
import { ModelSelector } from "./ModelSelector";
import { SidebarSettings } from "./SidebarSettings";
import {
  BackIcon,
  BoardIcon,
  CloseIcon,
  DocumentIcon,
  EditIcon,
  GearIcon,
  LibraryIcon,
  PanelIcon,
  SearchIcon,
  SlidersIcon,
  WrenchIcon,
} from "./icons";
import "./Sidebar.css";

interface SidebarProps {
  /** The page in the body. The admin page has no row here, but "새 대화" must
   *  not look selected while it is open either. */
  view: View;
  onOpenConversationSettings: () => void;
  onOpenToolsPanel: () => void;
  onOpenLibrary: () => void;
  onOpenDocuments: () => void;
  onOpenBoard: () => void;
  /** Brings the chat back into the body: the library page takes it over, so
   *  anything here that changes which conversation is shown has to. */
  onShowChat: () => void;
  /** Null for a non-administrator: the row is then not rendered at all. */
  onOpenAdmin: (() => void) | null;
  /**
   * 좁은 화면에서 서랍으로 떠 있을 때만 온다. 있으면 로고 줄 오른쪽(넓은 화면의 접기
   * 단추 자리)에 닫기 단추를 둔다 — 화면 구석에 떠 있는 토글 대신 서랍 안에서 닫는다.
   */
  onCloseDrawer?: () => void;
}

export function Sidebar({
  view,
  onOpenConversationSettings,
  onOpenToolsPanel,
  onOpenLibrary,
  onOpenDocuments,
  onOpenBoard,
  onShowChat,
  onOpenAdmin,
  onCloseDrawer,
}: SidebarProps) {
  const {
    ui,
    conversations,
    conversationsLoading,
    conversationsError,
    activeConversationId,
    createConversation,
    deleteConversation,
    renameConversation,
    selectConversation,
    importConversation,
    setSidebarCollapsed,
    refreshConversations,
  } = useStore();
  // 모델 이름·버튼 활성 여부에만 쓴다. 흐르는 값이지만 이 셋만 따라 움직이면 된다.
  const { activeConversation } = useActiveConversation();
  const libraryOpen = view === "library";
  const documentsOpen = view === "documents";
  const conversationSettingsOpen = view === "settings";
  const toolsPanelOpen = view === "tools";
  const boardOpen = view === "board";
  // 답을 만들고 있는 대화들. 집합이 바뀔 때만 다시 그려진다(토큰마다가 아니다).
  const generatingIds = useGeneratingConversationIds();

  // The subtitle under the model name says where that model actually runs, so
  // it has to follow the *selected* model, not the first catalog entry.
  const { catalog, current } = useModels();
  const selectedModelId = resolveSelectedModelId(catalog, current, activeConversation?.model ?? null, ui.lastModel);
  const endpoint = endpointLabel(catalog.find((entry) => entry.id === selectedModelId));

  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Ctrl/Cmd+K 를 누를 때마다 하나씩 는다. 접힌 레일에서 누르면 펼친 뒤 검색 칸이 그려지고
  // 나서야 포커스를 줄 수 있으므로, 요청을 값으로 남겨 두고 그린 뒤에 처리한다.
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  // 폰에서는 서랍 전체가 스크롤된다(Sidebar.css). 설정 화면은 서랍을 덮는 칸이라
  // 열 때 맨 위로 되돌려야 스크롤된 자리만큼 내려가 열리지 않는다.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (settingsOpen && asideRef.current) asideRef.current.scrollTop = 0;
  }, [settingsOpen]);

  // Close the bottom-row settings popover on outside click / Esc — purely
  // presentational open/closed state, mirrors the pattern used by the
  // composer's reasoning dropdown.
  useDismiss(settingsOpen, settingsRef, () => setSettingsOpen(false), { escape: true });

  // Ctrl/Cmd+K: 대화 제목 검색으로. 접힌 레일에는 검색 칸이 없어 펼치고, 설정 화면이
  // 덮여 있으면 걷는다. 좁은 화면에서 서랍이 닫혀 있으면 검색 칸이 보이지 않아 포커스가
  // 들어가지 않는다(서랍 여닫기는 App 의 몫).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.code !== "KeyK" && event.key.toLowerCase() !== "k") return;
      // 떠 있는 대화상자 밖으로 포커스를 빼내지 않는다.
      const input = searchRef.current;
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if ([...modals].some((modal) => !input || !modal.contains(input))) return;
      event.preventDefault();
      setSettingsOpen(false);
      setSidebarCollapsed(false);
      setSearchFocusRequest((n) => n + 1);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSidebarCollapsed]);

  useEffect(() => {
    if (searchFocusRequest === 0) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchFocusRequest, ui.sidebarCollapsed]);

  // 브라우저 기본 alert 는 앱 밖으로 튀고, 탭 전체를 막고, 이 앱의 테마를
  // 따르지 않는다. 실패도 앱이 말하게 한다.
  function reportError(error: unknown) {
    showErrorToast(error);
  }

  function startNewConversation() {
    onShowChat();
    void createConversation().catch(reportError);
  }

  async function commitRename(id: string, title: string) {
    if (editingId !== id) return;
    setEditingId(null);
    if (title.trim().length === 0) return;
    try {
      await renameConversation(id, title.trim());
    } catch (error) {
      reportError(error);
    }
  }

  async function togglePin(id: string, pinned: boolean) {
    try {
      await patchConversation(id, { pinned });
      await refreshConversations();
    } catch (error) {
      reportError(error);
    }
  }

  function openConversation(id: string) {
    onShowChat();
    void selectConversation(id);
  }

  // 목록 안에서 ↑↓·Home·End 로 줄을 옮겨 다닌다. 제목 단추만 센다 — 줄마다 Tab 이
  // 고정·이름·삭제 단추까지 세 번 더 멈추므로, 목록을 훑는 길은 화살표가 맡는다.
  function handleRecentsKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("sidebar-item-main")) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".sidebar-item-main")];
    const at = rows.indexOf(target as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    if (next < 0) {
      // 첫 줄에서 ↑ 는 검색 칸으로 돌아간다 — ↓ 로 내려온 길을 되짚는다.
      searchRef.current?.focus();
      return;
    }
    rows[Math.min(next, rows.length - 1)]?.focus();
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const shells = parseImportedConversations(JSON.parse(text));
      if (shells.length === 0) {
        showToast("가져올 대화가 없습니다.", "error");
        return;
      }
      for (const shell of shells) {
        await importConversation(shell);
      }
      // 성공도 말한다. 예전에는 메시지가 빠졌을 때만 알리고 멀쩡히 끝나면
      // 아무 말이 없어서, 정말 들어왔는지 목록을 세어 봐야 했다.
      const droppedTotal = shells.reduce((sum, s) => sum + s.droppedMessageCount, 0);
      if (droppedTotal > 0) {
        showToast(
          `대화 ${shells.length}개를 가져왔습니다.\n서버에 메시지 기록을 복원하는 API 가 없어 제목·시스템 프롬프트·설정만 복원했습니다 (메시지 ${droppedTotal}건 제외).`,
          "error",
        );
      } else {
        showToast(`대화 ${shells.length}개를 가져왔습니다.`);
      }
    } catch {
      showToast("파일을 가져오지 못했습니다. 올바른 JSON 형식인지 확인해 주세요.", "error");
    }
  }

  if (ui.sidebarCollapsed) {
    // Collapsed rail: the menu's actions stay reachable as icons (labels move
    // into the tooltip/aria-label); only the conversation list is hidden.
    return (
      <aside className="sidebar sidebar-collapsed">
        <button
          type="button"
          className="btn-icon sidebar-collapse-toggle"
          data-tooltip="사이드바 펼치기"
          aria-label="사이드바 펼치기"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelIcon />
        </button>

        <nav className="sidebar-rail-nav" aria-label="주요 메뉴">
          <button
            type="button"
            className="btn-icon sidebar-rail-item"
            data-tooltip="새 대화 (Ctrl+Shift+O)"
            aria-label="새 대화"
            aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
            onClick={startNewConversation}
          >
            <EditIcon />
          </button>
          <button
            type="button"
            className={`btn-icon sidebar-rail-item${libraryOpen ? " selected" : ""}`}
            data-tooltip="커넥터"
            aria-label="커넥터"
            aria-current={libraryOpen ? "true" : undefined}
            onClick={onOpenLibrary}
          >
            <LibraryIcon />
          </button>
          <button
            type="button"
            className={`btn-icon sidebar-rail-item${documentsOpen ? " selected" : ""}`}
            data-tooltip="문서"
            aria-label="문서"
            aria-current={documentsOpen ? "true" : undefined}
            onClick={onOpenDocuments}
          >
            <DocumentIcon />
          </button>
          <button
            type="button"
            className={`btn-icon sidebar-rail-item${boardOpen ? " selected" : ""}`}
            data-tooltip="문의 게시판"
            aria-label="문의 게시판"
            aria-current={boardOpen ? "true" : undefined}
            onClick={onOpenBoard}
          >
            <BoardIcon />
          </button>
          <div className="sidebar-rail-divider" role="presentation" />
          <button
            type="button"
            className="btn-icon sidebar-rail-item"
            data-tooltip="대화 설정"
            aria-label="대화 설정"
            disabled={!activeConversation}
            onClick={onOpenConversationSettings}
          >
            <SlidersIcon />
          </button>
          <button
            type="button"
            className="btn-icon sidebar-rail-item"
            data-tooltip="도구 설정"
            aria-label="도구 설정"
            disabled={!activeConversation}
            onClick={onOpenToolsPanel}
          >
            <WrenchIcon />
          </button>
          <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(e) => void handleImportFile(e)} />
        </nav>

        {/* Settings stays reachable while the sidebar is a rail; the popover
            opens to the right, because 72px leaves no room above. */}
        <div className="sidebar-rail-bottom" ref={settingsRef}>
          <button
            type="button"
            className="btn-icon sidebar-rail-item"
            data-tooltip="설정"
            aria-label="설정"
            aria-haspopup="true"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <GearIcon />
          </button>
          <SidebarSettings
            popover
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onOpenAdmin={onOpenAdmin}
            onImport={handleImportClick}
          />
        </div>
      </aside>
    );
  }

  // Mirrors the reference's default-selected first row: "새 대화" reads as
  // selected whenever the current view is the fresh/empty composer screen
  // (no conversation open yet, or one open with nothing sent) and nothing
  // else has taken the body — neither settings panel, nor any of the pages.
  //
  // Every page that replaces the body belongs in this list. Leaving one out
  // lights up "새 대화" while the user is plainly looking at something else,
  // and the only clue that the row lies is the screen itself.
  const visibleConversations = filterByTitle(conversations, query);
  const groups = groupConversationsByDate(visibleConversations);

  const isFreshView = (!activeConversation || activeConversation.messages.length === 0) && view === "chat";

  return (
    <aside ref={asideRef} className={`sidebar${settingsOpen ? " settings-open" : ""}`}>
      <div className="sidebar-brand">
        {/* The mark is the way back to a blank prompt, from anywhere: it starts
            a new conversation whatever is on screen, including the admin page's
            sibling view and a conversation already open. */}
        <button
          type="button"
          className="sidebar-brand-button"
          data-tooltip="새 대화 시작"
          aria-label={`${BRAND_WORDMARK} — 새 대화 시작`}
          onClick={startNewConversation}
        >
          <BrandMark size={24} className="brand-mark" />
          <span className="brand-wordmark">{BRAND_WORDMARK}</span>
        </button>
        {onCloseDrawer ? (
          <button
            type="button"
            className="btn-icon sidebar-collapse-toggle"
            data-tooltip="메뉴 닫기"
            aria-label="메뉴 닫기"
            onClick={onCloseDrawer}
          >
            <CloseIcon />
          </button>
        ) : (
          <button
            type="button"
            className="btn-icon sidebar-collapse-toggle"
            data-tooltip="사이드바 접기"
            aria-label="사이드바 접기"
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelIcon />
          </button>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="주요 메뉴">
        <button
          type="button"
          className={`sidebar-nav-item${isFreshView ? " selected" : ""}`}
          aria-current={isFreshView ? "true" : undefined}
          aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
          data-tooltip="Ctrl+Shift+O"
          onClick={startNewConversation}
        >
          <EditIcon />
          <span>새 대화</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${libraryOpen ? " selected" : ""}`}
          aria-current={libraryOpen ? "true" : undefined}
          onClick={onOpenLibrary}
        >
          <LibraryIcon />
          <span>커넥터</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${documentsOpen ? " selected" : ""}`}
          aria-current={documentsOpen ? "true" : undefined}
          onClick={onOpenDocuments}
        >
          <DocumentIcon />
          <span>문서</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${boardOpen ? " selected" : ""}`}
          aria-current={boardOpen ? "true" : undefined}
          onClick={onOpenBoard}
        >
          <BoardIcon />
          <span>문의 게시판</span>
        </button>
        {/* 아래 둘은 갈 곳이 아니라 지금 대화의 속성이다. 같은 무게로 여섯 줄을 늘어놓으면
            목적지와 속성이 섞여 메뉴가 꽉 차 보였다. 선 하나 아래 작게 둔다. 가져오기는 설정 화면으로. */}
        <div className="sidebar-nav-divider" role="presentation" />
        <button
          type="button"
          className={`sidebar-nav-item sidebar-nav-item-secondary${conversationSettingsOpen ? " selected" : ""}`}
          aria-current={conversationSettingsOpen ? "true" : undefined}
          disabled={!activeConversation}
          onClick={onOpenConversationSettings}
        >
          <SlidersIcon />
          <span>대화 설정</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item sidebar-nav-item-secondary${toolsPanelOpen ? " selected" : ""}`}
          aria-current={toolsPanelOpen ? "true" : undefined}
          disabled={!activeConversation}
          onClick={onOpenToolsPanel}
        >
          <WrenchIcon />
          <span>도구 설정</span>
        </button>
        <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(e) => void handleImportFile(e)} />
      </nav>

      {/* 검색 칸. 목록 위에 붙박이로 두고(목록만 스크롤된다), 거르는 것은 제목뿐이다. */}
      <div className="sidebar-search" role="search">
        <SearchIcon />
        <input
          ref={searchRef}
          type="search"
          className="sidebar-search-input"
          placeholder="대화 제목 검색 (Ctrl+K)"
          aria-label="대화 제목 검색"
          aria-keyshortcuts="Control+K Meta+K"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Esc 는 먼저 검색어를 지운다. 전역 Esc(생성 중단)까지 가지 않게 여기서 멈춘다.
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.nativeEvent.stopPropagation();
              setQuery("");
              return;
            }
            // ↓ 는 목록 첫 줄로(거기서부터는 ↑↓), Enter 는 맨 위에 보이는 대화를 바로 연다.
            if (event.key === "ArrowDown") {
              const first = document.querySelector<HTMLButtonElement>(".sidebar-recents .sidebar-item-main");
              if (first) {
                event.preventDefault();
                first.focus();
              }
              return;
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing && query.trim()) {
              const top = groups[0]?.items[0];
              if (top) {
                event.preventDefault();
                openConversation(top.id);
              }
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="btn-icon sidebar-search-clear"
            aria-label="검색어 지우기"
            data-tooltip="검색어 지우기"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <div className="sidebar-recents" onKeyDown={handleRecentsKeyDown}>
        {conversationsLoading && <p className="sidebar-empty">불러오는 중…</p>}
        {conversationsError && <p className="sidebar-empty">{conversationsError}</p>}
        {!conversationsLoading && !conversationsError && conversations.length === 0 && (
          <div className="sidebar-empty">
            <p>아직 대화가 없습니다</p>
            <p className="sidebar-empty-hint">위의 새 대화로 시작해 보세요</p>
          </div>
        )}
        {conversations.length > 0 && visibleConversations.length === 0 && (
          <p className="sidebar-empty">일치하는 대화가 없습니다</p>
        )}
        {groups.map((group) => (
          <Fragment key={group.key}>
            <p className="sidebar-section-label">{group.label}</p>
            {group.items.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                query={query}
                active={conversation.id === activeConversationId}
                generating={generatingIds.has(conversation.id)}
                editing={editingId === conversation.id}
                onSelect={() => openConversation(conversation.id)}
                onStartEdit={() => setEditingId(conversation.id)}
                onCancelEdit={() => setEditingId(null)}
                onRename={commitRename}
                onTogglePin={() => void togglePin(conversation.id, conversation.pinned !== true)}
                onDelete={() => setPendingDelete({ id: conversation.id, title: conversation.title })}
              />
            ))}
          </Fragment>
        ))}
      </div>

      <div className="sidebar-bottom">
        {/* Which model, and where it runs — one block, on its own line. The
            decorative glyph that used to sit here was aria-hidden and cost 42px
            of a 280px sidebar, which is what pushed both of these strings into
            an ellipsis nobody could read without hovering. */}
        <div className="sidebar-bottom-model">
          <ModelSelector />
          {/* 서버 주소는 늘 띄우지 않는다 — 모델 목록의 각 줄에 이미 있고, 사이드바 바닥의 둘째
              줄은 평소엔 읽을 일이 없는 글자였다. 연결이 끊겼을 때만 여기서 알린다. */}
          {endpoint.unreachable && (
            <span className="sidebar-bottom-subtitle" data-tone="danger" data-tooltip={endpoint.title}>
              {endpoint.text}
            </span>
          )}
        </div>

        {/* Carries its name rather than being an icon nobody can name, and uses
            the same row as the menu at the top of the sidebar. */}
        <button
          type="button"
          className={`sidebar-nav-item${settingsOpen ? " selected" : ""}`}
          aria-haspopup="true"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <GearIcon />
          <span>설정</span>
        </button>
      </div>

      {/* 설정은 사이드바 전체를 바꿔 끼우는 화면이다. 늘 그려 두고 열고 닫을 때
          미끄러지게 하며, 닫혀 있는 동안은 inert 로 포커스·클릭을 받지 않는다. */}
      <div
        ref={settingsRef}
        className={`sidebar-settings-page${settingsOpen ? " open" : ""}`}
        aria-hidden={!settingsOpen}
        inert={!settingsOpen}
      >
        <div className="sidebar-settings-page-header">
          <button
            type="button"
            className="btn-icon"
            aria-label="설정 닫기"
            data-tooltip="뒤로"
            onClick={() => setSettingsOpen(false)}
          >
            <BackIcon />
          </button>
          <h2 className="sidebar-settings-page-title">설정</h2>
        </div>
        <div className="sidebar-settings-page-body">
          <SidebarSettings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onOpenAdmin={onOpenAdmin}
            onImport={handleImportClick}
          />
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`「${pendingDelete.title}」 대화를 삭제할까요?`}
          message="메시지와 첨부 파일이 함께 삭제되며 되돌릴 수 없습니다."
          confirmLabel="삭제"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const { id, title } = pendingDelete;
            setPendingDelete(null);
            void deleteConversation(id)
              .then(() => showToast(`「${title}」 대화를 삭제했습니다.`))
              .catch(reportError);
          }}
        />
      )}
    </aside>
  );
}
