import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../state/StoreContext";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { KeyIcon, LockIcon, LogoutIcon, ServerIcon, ShieldIcon, UploadIcon } from "./icons";
import { ModelEndpointDialog } from "./ModelEndpointDialog";
import { PersonalKeysDialog } from "./PersonalKeysDialog";

interface SidebarSettingsProps {
  /** The collapsed rail shows the items as a popover, only while open. The full
   *  sidebar always renders them inside its settings screen. */
  popover?: boolean;
  open: boolean;
  /** Closes the settings menu; every item does so before it acts. */
  onClose: () => void;
  /** Null for a non-administrator: the row is then not rendered at all. */
  onOpenAdmin: (() => void) | null;
  onImport: () => void;
}

/**
 * 사이드바 설정 메뉴의 항목들과, 그 항목이 여는 대화상자들(비밀번호·개인 키·모델
 * 연동·로그아웃 확인). 대화상자는 메뉴가 닫힌 뒤에 뜨므로 메뉴와 따로 늘 그려진다.
 */
export function SidebarSettings({ popover = false, open, onClose, onOpenAdmin, onImport }: SidebarSettingsProps) {
  const { ui, setTheme } = useStore();
  const { me, logout } = useAuth();
  const [endpointsOpen, setEndpointsOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

  // One definition, rendered by both the full sidebar and the collapsed
  // rail, so the two can never drift apart. 겉모양만 다르다: 펼친 사이드바에서는
  // 사이드바 전체를 덮는 설정 화면(sidebar-settings-page)이 되고, 68px 레일에는 그
  // 화면을 둘 자리가 없어 옆으로 뜨는 팝오버로 남는다.
  const items = (
    <>
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
          onClose();
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
          onClose();
          setKeysOpen(true);
        }}
      >
        <LockIcon />
        <span>개인 키 (API 키·토큰)</span>
      </button>
      {onOpenAdmin && (
        <button
          type="button"
          className="sidebar-settings-action"
          onClick={() => {
            onClose();
            onOpenAdmin();
          }}
        >
          <ShieldIcon />
          <span>관리자 메뉴</span>
        </button>
      )}

      {/* 누구나 모델 서버를 연동한다. 등록한 서버는 본인 그룹과 AI Product 팀만 쓴다(server/vllm/access.ts). */}
      <p className="sidebar-settings-heading">모델</p>
      <button
        type="button"
        className="sidebar-settings-action"
        onClick={() => {
          onClose();
          setEndpointsOpen(true);
        }}
      >
        <ServerIcon />
        <span>모델 연동</span>
      </button>

      <p className="sidebar-settings-heading">대화</p>
      {/* 파일 입력(fileInputRef)은 메뉴 쪽에 그대로 있다 — 설정 화면은 그 위에 덮일 뿐이라
          닫혀도 입력이 사라지지 않고, 파일 창이 닫힌 뒤의 onChange 를 받는다. */}
      <button
        type="button"
        className="sidebar-settings-action"
        onClick={() => {
          onClose();
          onImport();
        }}
      >
        <UploadIcon />
        <span>대화 가져오기 (JSON)</span>
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
          onClose();
          setConfirmLogout(true);
        }}
      >
        <LogoutIcon />
        <span>로그아웃</span>
      </button>
    </>
  );

  // Overlays: they position themselves, so it does not matter which branch
  // renders them, only that every branch does.
  const dialogs = (
    <>
      {endpointsOpen && <ModelEndpointDialog onClose={() => setEndpointsOpen(false)} />}
      {passwordOpen && <ChangePasswordDialog onClose={() => setPasswordOpen(false)} />}
      {keysOpen && <PersonalKeysDialog onClose={() => setKeysOpen(false)} />}
      {confirmLogout && (
        <ConfirmDialog
          title="로그아웃할까요?"
          message={`${me?.name ?? ""} (${me?.id ?? ""}) 계정에서 로그아웃합니다.`}
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

  return (
    <>
      {popover ? open && <div className="sidebar-settings-popover">{items}</div> : items}
      {dialogs}
    </>
  );
}
