import { useEffect, useState } from "react";
import "./Toast.css";

/**
 * A brief message that appears and takes itself away. One at a time: a second
 * call replaces the first rather than queueing, because a queue would make the
 * last message arrive long after the action that caused it.
 *
 * The host is mounted once by the app shell, so any component can say something
 * without threading a callback down to it.
 *
 * 성격이 둘이다. **확인**("복사되었습니다")은 읽히지 않아도 그만이라 짧게
 * 머물고, 조용히 알린다. **실패**는 사람이 무엇을 해야 할지 정하는 근거라
 * 더 오래 머물고, 보조 기술에도 곧바로 끼어든다. 같은 시간·같은 색으로 두면
 * 둘 중 하나는 반드시 잘못 다뤄진다.
 */
type Tone = "info" | "error";

const VISIBLE_MS: Record<Tone, number> = {
  info: 1800,
  // 실패는 대개 문장이 길고, 읽고 나서 할 일이 있다.
  error: 5000,
};

interface ToastState {
  message: string;
  tone: Tone;
}

type Listener = (toast: ToastState | null) => void;

let listener: Listener | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, tone: Tone = "info"): void {
  clearTimeout(timer);
  listener?.({ message, tone });
  timer = setTimeout(() => listener?.(null), VISIBLE_MS[tone]);
}

/** 실패를 말한다. 무엇이 실패했는지는 부르는 쪽이 문장으로 준다. */
export function showErrorToast(error: unknown): void {
  showToast(error instanceof Error ? error.message : String(error), "error");
}

export function ToastHost() {
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    listener = setToast;
    return () => {
      listener = null;
      clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;

  const isError = toast.tone === "error";

  return (
    // 확인은 aria-live 로 흘려보내고(이미 읽고 있는 것을 끊지 않는다), 실패는
    // alert 로 곧바로 알린다 — 놓치면 무엇이 잘못됐는지 알 길이 없다.
    <div
      className="toast"
      data-tone={toast.tone}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      {toast.message}
    </div>
  );
}
