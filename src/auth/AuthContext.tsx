import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api/client";
import { setUnauthorizedHandler } from "../api/client";
import type { AuthUser, SignupRequest } from "../api/types";

/**
 * "loading" is the state the whole app waits in on first paint: until
 * `GET /api/auth/me` answers we do not know whether to show the chat or the
 * login screen, and showing either one early means showing the wrong one.
 */
export type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthValue {
  status: AuthStatus;
  me: AuthUser | null;
  isAdmin: boolean;
  /** Non-null when the session was ended by the server rather than by the user. */
  sessionEndedNotice: string | null;
  login: (id: string, password: string) => Promise<void>;
  signup: (body: SignupRequest) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  clearSessionEndedNotice: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

const SESSION_ENDED_NOTICE = "세션이 만료되었습니다. 다시 로그인해주세요.";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [me, setMe] = useState<AuthUser | null>(null);
  const [sessionEndedNotice, setSessionEndedNotice] = useState<string | null>(null);

  /** A user who is signed in but not active must not reach the chat app. */
  const adopt = useCallback((user: AuthUser | null) => {
    if (user && user.status === "active") {
      setMe(user);
      setStatus("authenticated");
      return;
    }
    setMe(null);
    setStatus("anonymous");
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((user) => {
        if (!cancelled) adopt(user);
      })
      .catch(() => {
        // The backend being unreachable is not a session: show the login
        // screen, where the failure is reported when the user tries.
        if (!cancelled) adopt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  // Read by the 401 handler below, which needs to know whether anyone *was*
  // signed in without reaching for state inside a setState updater (updaters
  // run during render, where another setState does not belong).
  const meRef = useRef<AuthUser | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  // Any later 401 — an expired session, a logout elsewhere, an account blocked
  // mid-session — drops straight back to the login screen instead of leaving a
  // half-loaded view behind.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only an interrupted session gets the notice; a 401 for someone who was
      // never signed in is just the login screen doing its job.
      if (meRef.current !== null) setSessionEndedNotice(SESSION_ENDED_NOTICE);
      setMe(null);
      setStatus("anonymous");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (id: string, password: string) => {
      // `password` lives only in this call frame: nothing here stores, caches
      // or logs it.
      const user = await api.login(id, password);
      setSessionEndedNotice(null);
      adopt(user);
    },
    [adopt],
  );

  const signup = useCallback(async (body: SignupRequest) => {
    await api.signup(body);
  }, []);

  // Neither password ever leaves this call frame, and a successful change does
  // not touch `me`: the server keeps this session signed in on purpose.
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.changePassword(currentPassword, newPassword);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Whatever the server said, this browser is signed out.
      setSessionEndedNotice(null);
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  const clearSessionEndedNotice = useCallback(() => setSessionEndedNotice(null), []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      me,
      isAdmin: me?.role === "admin",
      sessionEndedNotice,
      login,
      signup,
      changePassword,
      logout,
      clearSessionEndedNotice,
    }),
    [status, me, sessionEndedNotice, login, signup, changePassword, logout, clearSessionEndedNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
