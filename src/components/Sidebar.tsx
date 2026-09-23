import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { pushOverlay } from "../ui/overlayStack";
import { getConversation, getProhibitions } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useModels } from "../hooks/useModels";
import { endpointLabel, resolveSelectedModelId } from "../state/modelCatalog";
import { downloadJson, parseImportedConversations } from "../state/exportImport";
import { useStore, useActiveConversation } from "../state/StoreContext";
import { BRAND_WORDMARK, BrandMark } from "./BrandMark";
import { CapabilityIcon } from "./CapabilityIcon";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { ProhibitionsDialog } from "./ProhibitionsDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { showErrorToast, showToast } from "./Toast";
import { ModelEndpointDialog } from "./ModelEndpointDialog";
import { ModelSelector } from "./ModelSelector";
import "./Sidebar.css";

function PanelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 5v14" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="1.75" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="10" cy="18" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 7.3a4.5 4.5 0 0 1-6.02 4.24L7 19.5l-2.5-2.5 7.96-7.98A4.5 4.5 0 0 1 17.7 3l-3.2 3.2 1.5 1.5 3.2-3.2c.5.75.8 1.65.8 2.8Z" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H8v16H5.5A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M11 4h2.5A1.5 1.5 0 0 1 15 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11Z" />
      <path d="m17.4 6.6 1.9-.5a1 1 0 0 1 1.2.7l2.2 8.4" />
    </svg>
  );
}

/** A sheet with lines on it. Deliberately not the library's books: one holds
 *  tools, this holds text, and at rail size the difference has to be the shape. */
function DocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7.5 3v5.5c0 4.4-3.1 8.4-7.5 9.5-4.4-1.1-7.5-5.1-7.5-9.5V6Z" />
      <path d="M9.5 12l1.8 1.8 3.4-3.6" />
    </svg>
  );
}

function NoEntryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9" />
      <path d="M17.5 12v3.5" />
      <path d="M20.5 12v2.5" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" />
      <path d="M10 16l-4-4 4-4" />
      <path d="M6 12h9" />
    </svg>
  );
}

interface SidebarProps {
  conversationSettingsOpen: boolean;
  toolsPanelOpen: boolean;
  libraryOpen: boolean;
  documentsOpen: boolean;
  boardOpen: boolean;
  onOpenConversationSettings: () => void;
  onOpenToolsPanel: () => void;
  onOpenLibrary: () => void;
  onOpenDocuments: () => void;
  /** Brings the chat back into the body: the library page takes it over, so
   *  anything here that changes which conversation is shown has to. */
  onShowChat: () => void;
  /** Null for a non-administrator: the row is then not rendered at all. */
  onOpenAdmin: (() => void) | null;
}

export function Sidebar({
  conversationSettingsOpen,
  toolsPanelOpen,
  libraryOpen,
  documentsOpen,
  boardOpen,
  onOpenConversationSettings,
  onOpenToolsPanel,
  onOpenLibrary,
  onOpenDocuments,
  onShowChat,
  onOpenAdmin,
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
    setTheme,
    setSidebarCollapsed,
  } = useStore();
  // 모델 이름·버튼 활성 여부에만 쓴다. 흐르는 값이지만 이 셋만 따라 움직이면 된다.
  const { activeConversation } = useActiveConversation();

  // The subtitle under the model name says where that model actually runs, so
  // it has to follow the *selected* model, not the first catalog entry.
  const { catalog, current } = useModels();
  const selectedModelId = resolveSelectedModelId(catalog, current, activeConversation?.model ?? null, ui.lastModel);
  const endpoint = endpointLabel(catalog.find((entry) => entry.id === selectedModelId));

  const { me, logout } = useAuth();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 메뉴가 떠 있는 동안은 Esc 가 이쪽 몫이다 — 전역 Esc(생성 중단)와 겹치지 않게.
  useEffect(() => (settingsOpen ? pushOverlay() : undefined), [settingsOpen]);
  const [endpointsOpen, setEndpointsOpen] = useState(false);

  const [confirmLogout, setConfirmLogout] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [prohibitionsOpen, setProhibitionsOpen] = useState(false);
  // 메뉴를 열 때마다 새로 센다. 검토 대기는 대화 도중 서버가 보태므로, 앱을 연
  // 시점의 값은 금방 낡는다.
  const [prohibitionsPending, setProhibitionsPending] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close the bottom-row settings popover on outside click / Esc — purely
  // presentational open/closed state, mirrors the pattern used by the
  // composer's reasoning dropdown.
  useEffect(() => {
    if (!settingsOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    let alive = true;
    getProhibitions()
      .then((res) => alive && setProhibitionsPending(res.pendingCount))
      .catch(() => {
        // 개수를 못 세도 메뉴는 그대로 쓸 수 있다.
      });
    return () => {
      alive = false;
    };
  }, [settingsOpen]);

  // 브라우저 기본 alert 는 앱 밖으로 튀고, 탭 전체를 막고, 이 앱의 테마를
  // 따르지 않는다. 실패도 앱이 말하게 한다.
  function reportError(error: unknown) {
    showErrorToast(error);
  }

  function startNewConversation() {
    onShowChat();
    void createConversation().catch(reportError);
  }

  function startEditing(id: string, currentTitle: string) {
    setEditingId(id);
    setEditValue(currentTitle);
  }

  async function commitEditing() {
    const id = editingId;
    setEditingId(null);
    if (!id || editValue.trim().length === 0) return;
    try {
      await renameConversation(id, editValue.trim());
    } catch (error) {
      reportError(error);
    }
  }

  async function handleExportAll() {
    try {
      const full = await Promise.all(conversations.map((c) => getConversation(c.id)));
      downloadJson(`qwen3-conversations-${Date.now()}.json`, full);
      showToast(`대화 ${full.length}개를 내보냈습니다.`);
    } catch (error) {
      reportError(error);
    }
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

  // One definition, rendered by both the full sidebar and the collapsed
  // rail, so the two can never drift apart.
  const settingsMenu = settingsOpen && (
    <div className="sidebar-settings-popover">
      <p className="sidebar-settings-heading">계정</p>
      <div className="sidebar-account">
        <span className="sidebar-account-name">{me?.name ?? "알 수 없는 사용자"}</span>
        <span className="sidebar-account-id">
          {me?.id ?? "-"}
          {me?.role === "admin" && <span className="sidebar-account-role">관리자</span>}
        </span>
      </div>

      <button
        type="button"
        className="sidebar-settings-action"
        onClick={() => {
          setSettingsOpen(false);
          setPasswordOpen(true);
        }}
      >
        <KeyIcon />
        <span>비밀번호 변경</span>
      </button>
      <button
        type="button"
        className="sidebar-settings-action"
        onClick={() => {
          setSettingsOpen(false);
          setProhibitionsOpen(true);
        }}
      >
        <NoEntryIcon />
        <span>하지 말 것 목록</span>
        {prohibitionsPending > 0 && (
          <span className="sidebar-settings-badge" aria-label={`검토 대기 ${prohibitionsPending}건`}>
            {prohibitionsPending}
          </span>
        )}
      </button>
      {onOpenAdmin && (
        <button
          type="button"
          className="sidebar-settings-action"
          onClick={() => {
            setSettingsOpen(false);
            onOpenAdmin();
          }}
        >
          <ShieldIcon />
          <span>계정 관리</span>
        </button>
      )}

      <p className="sidebar-settings-heading">모델</p>
      <button
        type="button"
        className="sidebar-settings-action"
        onClick={() => {
          setSettingsOpen(false);
          setEndpointsOpen(true);
        }}
      >
        <ServerIcon />
        <span>모델 연동</span>
      </button>

      <p className="sidebar-settings-heading">테마</p>
      <div className="sidebar-theme">
        {(["system", "light", "dark"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`theme-option${ui.theme === mode ? " active" : ""}`}
            onClick={() => setTheme(mode)}
          >
            {mode === "system" ? "시스템" : mode === "light" ? "라이트" : "다크"}
          </button>
        ))}
      </div>
      {/* Last, and behind a rule: leaving is not a setting, and it is the
          one item here you do not want to hit while aiming for another. */}
      <div className="sidebar-settings-divider" role="presentation" />
      <button
        type="button"
        className="sidebar-settings-action"
        onClick={() => {
          setSettingsOpen(false);
          setConfirmLogout(true);
        }}
      >
        <LogoutIcon />
        <span>로그아웃</span>
      </button>
    </div>
  );

  // Overlays: they position themselves, so it does not matter which branch
  // renders them, only that every branch does.
  const settingsDialogs = (
    <>
      {endpointsOpen && <ModelEndpointDialog onClose={() => setEndpointsOpen(false)} />}
      {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />}
      {prohibitionsOpen && <ProhibitionsDialog onClose={() => setProhibitionsOpen(false)} />}
    {confirmLogout && (
      <ConfirmDialog
        title="로그아웃"
        message={`${me?.name ?? ""} (${me?.id ?? ""}) 계정에서 로그아웃하시겠습니까?`}
        confirmLabel="로그아웃"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false);
          void logout();
        }}
      />
    )}
    </>
  );

  if (ui.sidebarCollapsed) {
    // Collapsed rail: the five actions stay reachable as icons (labels move
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
            data-tooltip="새 대화"
            aria-label="새 대화"
            onClick={startNewConversation}
          >
            <EditIcon />
          </button>
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
          <button
            type="button"
            className={`btn-icon sidebar-rail-item${libraryOpen ? " selected" : ""}`}
            data-tooltip="라이브러리"
            aria-label="라이브러리"
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
            className="btn-icon sidebar-rail-item"
            data-tooltip="내보내기"
            aria-label="내보내기"
            disabled={conversations.length === 0}
            onClick={() => void handleExportAll()}
          >
            <DownloadIcon />
          </button>
          <button
            type="button"
            className="btn-icon sidebar-rail-item"
            data-tooltip="가져오기"
            aria-label="가져오기"
            onClick={handleImportClick}
          >
            <UploadIcon />
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
          {settingsMenu}
        </div>

        {settingsDialogs}
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
  const isFreshView =
    (!activeConversation || activeConversation.messages.length === 0) &&
    !conversationSettingsOpen &&
    !toolsPanelOpen &&
    !libraryOpen &&
    !documentsOpen &&
    !boardOpen;

  return (
    <aside className="sidebar">
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
        <button
          type="button"
          className="btn-icon sidebar-collapse-toggle"
          data-tooltip="사이드바 접기"
          aria-label="사이드바 접기"
          onClick={() => setSidebarCollapsed(true)}
        >
          <PanelIcon />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="주요 메뉴">
        <button
          type="button"
          className={`sidebar-nav-item${isFreshView ? " selected" : ""}`}
          aria-current={isFreshView ? "true" : undefined}
          onClick={startNewConversation}
        >
          <EditIcon />
          <span>새 대화</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${conversationSettingsOpen ? " selected" : ""}`}
          aria-current={conversationSettingsOpen ? "true" : undefined}
          disabled={!activeConversation}
          onClick={onOpenConversationSettings}
        >
          <SlidersIcon />
          <span>대화 설정</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${toolsPanelOpen ? " selected" : ""}`}
          aria-current={toolsPanelOpen ? "true" : undefined}
          disabled={!activeConversation}
          onClick={onOpenToolsPanel}
        >
          <WrenchIcon />
          <span>도구 설정</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-item${libraryOpen ? " selected" : ""}`}
          aria-current={libraryOpen ? "true" : undefined}
          onClick={onOpenLibrary}
        >
          <LibraryIcon />
          <span>라이브러리</span>
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
        <button type="button" className="sidebar-nav-item" onClick={() => void handleExportAll()} disabled={conversations.length === 0}>
          <DownloadIcon />
          <span>내보내기</span>
        </button>
        <button type="button" className="sidebar-nav-item" onClick={handleImportClick}>
          <UploadIcon />
          <span>가져오기</span>
        </button>
        <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={(e) => void handleImportFile(e)} />
      </nav>

      <p className="sidebar-section-label">최근</p>

      <div className="sidebar-recents">
        {conversationsLoading && <p className="sidebar-empty">불러오는 중…</p>}
        {conversationsError && <p className="sidebar-empty">{conversationsError}</p>}
        {!conversationsLoading && !conversationsError && conversations.length === 0 && (
          <p className="sidebar-empty">대화가 없습니다. 새 대화를 시작해보세요.</p>
        )}
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`sidebar-item${conversation.id === activeConversationId ? " active" : ""}`}
            onClick={() => {
              onShowChat();
              void selectConversation(conversation.id);
            }}
          >
            <CapabilityIcon kind={conversation.kind} className="sidebar-item-kind" />

            {editingId === conversation.id ? (
              <input
                autoFocus
                className="sidebar-item-input"
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onBlur={() => void commitEditing()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commitEditing();
                  if (event.key === "Escape") setEditingId(null);
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span
                className="sidebar-item-title"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  startEditing(conversation.id, conversation.title);
                }}
                data-tooltip={conversation.title}
              >
                {conversation.title}
              </span>
            )}

            <div className="sidebar-item-actions">
              <button
                type="button"
                className="btn-icon"
                data-tooltip="이름 변경"
                aria-label="대화 이름 변경"
                onClick={(event) => {
                  event.stopPropagation();
                  startEditing(conversation.id, conversation.title);
                }}
              >
                <EditIcon />
              </button>
              <button
                type="button"
                className="btn-icon"
                data-tooltip="삭제"
                aria-label="대화 삭제"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDeleteId(conversation.id);
                }}
              >
                <TrashIcon />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-bottom" ref={settingsRef}>
        {/* Which model, and where it runs — one block, on its own line. The
            decorative glyph that used to sit here was aria-hidden and cost 42px
            of a 280px sidebar, which is what pushed both of these strings into
            an ellipsis nobody could read without hovering. */}
        <div className="sidebar-bottom-model">
          <ModelSelector />
          <span
            className="sidebar-bottom-subtitle"
            data-tone={endpoint.unreachable ? "danger" : undefined}
            data-tooltip={endpoint.title}
          >
            {endpoint.text}
          </span>
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

        {settingsMenu}

      </div>

      {settingsDialogs}

      {pendingDeleteId && (
        <ConfirmDialog
          title="대화 삭제"
          message="이 대화를 삭제하시겠습니까? 되돌릴 수 없습니다."
          confirmLabel="삭제"
          danger
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => {
            const id = pendingDeleteId;
            setPendingDeleteId(null);
            void deleteConversation(id).catch(reportError);
          }}
        />
      )}
    </aside>
  );
}
