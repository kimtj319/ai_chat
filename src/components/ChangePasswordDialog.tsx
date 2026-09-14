import { useState, type FormEvent } from "react";
import { AuthError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { authErrorMessage } from "../auth/messages";
import {
  hasErrors,
  PASSWORD_MIN_LENGTH,
  validateChangePassword,
  type FieldErrors,
} from "../auth/validation";
import { Modal } from "./Modal";
import "./ChangePasswordDialog.css";

type Errors = FieldErrors<"currentPassword" | "newPassword" | "confirm">;

/**
 * Change your own password. There is no id field and no way to name another
 * account: the server takes the account from the session, so this dialog can
 * only ever act on the person using it.
 *
 * None of the three values is kept anywhere but this component's state, and all
 * three are cleared the moment the change succeeds.
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [fieldErrors, setFieldErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const errors = validateChangePassword({ currentPassword, newPassword, confirm });
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;

    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (error) {
      const code = error instanceof AuthError ? error.code : null;
      const fallback = error instanceof Error ? error.message : undefined;
      // authErrorMessage renders invalid_credentials as login copy ("아이디 또는
      // 비밀번호가..."), which is wrong here: this form has no id field, and the
      // only credential it submits is the current password.
      setFormError(
        code === "invalid_credentials"
          ? "현재 비밀번호가 올바르지 않습니다."
          : authErrorMessage(code, fallback),
      );
      // Clear only the field that was actually wrong. Wiping the new password
      // too would make one typo cost three retypes.
      if (code === "invalid_credentials") setCurrentPassword("");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal title="비밀번호 변경" onClose={onClose} width={420}>
        <p className="pw-done" role="status">
          비밀번호를 변경했습니다.
        </p>
        <p className="pw-note">
          다른 기기에 남아 있던 로그인은 모두 해제되었습니다. 지금 사용 중인 창은 그대로 유지됩니다.
        </p>
        <div className="pw-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            확인
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="비밀번호 변경" onClose={onClose} width={420}>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="field">
          <label htmlFor="pw-current">현재 비밀번호</label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            aria-invalid={fieldErrors.currentPassword ? true : undefined}
            aria-describedby={fieldErrors.currentPassword ? "pw-current-error" : undefined}
          />
          {fieldErrors.currentPassword && (
            <p className="auth-field-error" id="pw-current-error">
              {fieldErrors.currentPassword}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="pw-new">새 비밀번호</label>
          <input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            aria-invalid={fieldErrors.newPassword ? true : undefined}
            aria-describedby={fieldErrors.newPassword ? "pw-new-error" : undefined}
          />
          {fieldErrors.newPassword ? (
            <p className="auth-field-error" id="pw-new-error">
              {fieldErrors.newPassword}
            </p>
          ) : (
            <span className="field-hint">{PASSWORD_MIN_LENGTH}자 이상 입력해주세요.</span>
          )}
        </div>

        <div className="field">
          <label htmlFor="pw-confirm">새 비밀번호 확인</label>
          <input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={fieldErrors.confirm ? true : undefined}
            aria-describedby={fieldErrors.confirm ? "pw-confirm-error" : undefined}
          />
          {fieldErrors.confirm && (
            <p className="auth-field-error" id="pw-confirm-error">
              {fieldErrors.confirm}
            </p>
          )}
        </div>

        {formError && (
          <p className="message-error" role="alert">
            {formError}
          </p>
        )}

        <p className="pw-note">변경하면 다른 기기의 로그인은 모두 해제됩니다.</p>

        <div className="pw-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "변경 중…" : "변경"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
