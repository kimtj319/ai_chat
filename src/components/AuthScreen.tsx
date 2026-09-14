import { useState, type FormEvent } from "react";
import { AuthError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { authErrorMessage, PENDING_APPROVAL_NOTICE } from "../auth/messages";
import {
  hasErrors,
  PASSWORD_MIN_LENGTH,
  validateLogin,
  validateSignup,
  type FieldErrors,
} from "../auth/validation";
import { BRAND_WORDMARK, BrandMark } from "./BrandMark";
import "./AuthScreen.css";

type Mode = "login" | "signup";

type LoginErrors = FieldErrors<"id" | "password">;
type SignupErrors = FieldErrors<"id" | "name" | "email" | "password" | "confirm">;

export function AuthScreen() {
  const { login, signup, sessionEndedNotice, clearSessionEndedNotice } = useAuth();
  const [mode, setMode] = useState<Mode>("login");

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // Password state is local to this component and never persisted, logged, or
  // sent anywhere but the auth request itself. It is cleared on every outcome.
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [fieldErrors, setFieldErrors] = useState<LoginErrors & SignupErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [signupDone, setSignupDone] = useState(false);
  const [busy, setBusy] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setFieldErrors({});
    setFormError(null);
    setSignupDone(false);
    setPassword("");
    setConfirm("");
    clearSessionEndedNotice();
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    clearSessionEndedNotice();
    const errors = validateLogin({ id, password });
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;

    setBusy(true);
    try {
      await login(id.trim(), password);
      // Success unmounts this screen; nothing to reset.
    } catch (error) {
      // pending_approval vs invalid_credentials is the whole point: a user
      // whose password is right but whose account is not approved yet must be
      // told that, not that their password is wrong.
      const code = error instanceof AuthError ? error.code : null;
      const fallback = error instanceof Error ? error.message : undefined;
      setFormError(authErrorMessage(code, fallback));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignup(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const errors = validateSignup({ id, name, email, password, confirm });
    setFieldErrors(errors);
    setFormError(null);
    if (hasErrors(errors)) return;

    setBusy(true);
    try {
      await signup({ id: id.trim(), name: name.trim(), email: email.trim(), password });
      // Deliberately not signed in: the account is PENDING until approved.
      setSignupDone(true);
      setPassword("");
      setConfirm("");
    } catch (error) {
      const code = error instanceof AuthError ? error.code : null;
      const fallback = error instanceof Error ? error.message : undefined;
      setFormError(authErrorMessage(code, fallback));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-glow" aria-hidden="true" />

      <main className="auth-card">
        <div className="auth-brand">
          <BrandMark size={32} />
          <span className="auth-brand-wordmark">{BRAND_WORDMARK}</span>
        </div>

        {signupDone ? (
          <>
            <h1 className="auth-title">가입 신청 완료</h1>
            <p className="auth-notice" role="status">
              {PENDING_APPROVAL_NOTICE}
            </p>
            <p className="auth-subtitle">
              승인되면 <strong>{id.trim()}</strong> 계정으로 로그인할 수 있습니다.
            </p>
            <button type="button" className="btn btn-primary auth-submit" onClick={() => switchMode("login")}>
              로그인 화면으로
            </button>
          </>
        ) : mode === "login" ? (
          <>
            <h1 className="auth-title">로그인</h1>
            <p className="auth-subtitle">계정으로 로그인하면 대화를 이어갈 수 있습니다.</p>

            {sessionEndedNotice && (
              <p className="auth-notice" role="status">
                {sessionEndedNotice}
              </p>
            )}

            <form className="auth-form" onSubmit={(event) => void handleLogin(event)} noValidate>
              <div className="field">
                <label htmlFor="auth-login-id">아이디</label>
                <input
                  id="auth-login-id"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  aria-invalid={fieldErrors.id ? true : undefined}
                  aria-describedby={fieldErrors.id ? "auth-login-id-error" : undefined}
                />
                {fieldErrors.id && (
                  <p className="auth-field-error" id="auth-login-id-error">
                    {fieldErrors.id}
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="auth-login-password">비밀번호</label>
                <input
                  id="auth-login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={fieldErrors.password ? "auth-login-password-error" : undefined}
                />
                {fieldErrors.password && (
                  <p className="auth-field-error" id="auth-login-password-error">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              {formError && (
                <p className="auth-form-error" role="alert">
                  {formError}
                </p>
              )}

              <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                {busy ? "로그인 중…" : "로그인"}
              </button>
            </form>

            <p className="auth-switch">
              계정이 없으신가요?{" "}
              <button type="button" className="auth-link" onClick={() => switchMode("signup")}>
                가입 신청
              </button>
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">가입 신청</h1>
            <p className="auth-subtitle">관리자 승인 후 로그인할 수 있습니다.</p>

            <form className="auth-form" onSubmit={(event) => void handleSignup(event)} noValidate>
              <div className="field">
                <label htmlFor="auth-signup-id">아이디</label>
                <input
                  id="auth-signup-id"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  aria-invalid={fieldErrors.id ? true : undefined}
                  aria-describedby={fieldErrors.id ? "auth-signup-id-error" : undefined}
                />
                {fieldErrors.id && (
                  <p className="auth-field-error" id="auth-signup-id-error">
                    {fieldErrors.id}
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="auth-signup-name">실명</label>
                <input
                  id="auth-signup-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={fieldErrors.name ? true : undefined}
                  aria-describedby={fieldErrors.name ? "auth-signup-name-error" : undefined}
                />
                {fieldErrors.name && (
                  <p className="auth-field-error" id="auth-signup-name-error">
                    {fieldErrors.name}
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="auth-signup-email">이메일</label>
                <input
                  id="auth-signup-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={fieldErrors.email ? true : undefined}
                  aria-describedby={fieldErrors.email ? "auth-signup-email-error" : undefined}
                />
                {fieldErrors.email && (
                  <p className="auth-field-error" id="auth-signup-email-error">
                    {fieldErrors.email}
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="auth-signup-password">비밀번호</label>
                <input
                  id="auth-signup-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={
                    fieldErrors.password ? "auth-signup-password-error" : "auth-signup-password-hint"
                  }
                />
                {fieldErrors.password ? (
                  <p className="auth-field-error" id="auth-signup-password-error">
                    {fieldErrors.password}
                  </p>
                ) : (
                  <p className="field-hint" id="auth-signup-password-hint">
                    {PASSWORD_MIN_LENGTH}자 이상 입력해주세요.
                  </p>
                )}
              </div>

              <div className="field">
                <label htmlFor="auth-signup-confirm">비밀번호 확인</label>
                <input
                  id="auth-signup-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  aria-invalid={fieldErrors.confirm ? true : undefined}
                  aria-describedby={fieldErrors.confirm ? "auth-signup-confirm-error" : undefined}
                />
                {fieldErrors.confirm && (
                  <p className="auth-field-error" id="auth-signup-confirm-error">
                    {fieldErrors.confirm}
                  </p>
                )}
              </div>

              {formError && (
                <p className="auth-form-error" role="alert">
                  {formError}
                </p>
              )}

              <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
                {busy ? "신청하는 중…" : "가입 신청"}
              </button>
            </form>

            <p className="auth-switch">
              이미 계정이 있으신가요?{" "}
              <button type="button" className="auth-link" onClick={() => switchMode("login")}>
                로그인
              </button>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
