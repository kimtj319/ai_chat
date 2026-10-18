import { useCallback, useEffect, useRef, useState } from "react";
import { getHealth } from "../api/client";
import { showToast } from "../components/Toast";

export type HealthStatus = "checking" | "ok" | "vllm_unreachable" | "backend_down";

const POLL_INTERVAL_MS = 15000;

/** 끊겼던 연결이 돌아왔을 때 한 번 띄우는 토스트. */
const RECONNECTED_TOAST = "다시 연결되었습니다.";

async function checkOnce(): Promise<HealthStatus> {
  try {
    const health = await getHealth();
    return health.vllm === "ok" ? "ok" : "vllm_unreachable";
  } catch {
    return "backend_down";
  }
}

/**
 * 15초마다 서버와 모델 서버를 확인한다. 탭이 가려져 있는 동안은 쉬고(볼 사람이 없다),
 * 다시 보이면 곧바로 한 번 확인한 뒤 주기를 잇는다. 주기 확인 중에는 마지막 결과를 그대로 둔다 —
 * 확인할 때마다 "checking" 으로 돌리면 배너가 15초마다 사라졌다 다시 뜬다.
 * `retrying` 은 [지금 다시 시도] 로 시작한 확인이 도는 동안만 참이다.
 */
export function useHealthCheck() {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const [retrying, setRetrying] = useState(false);
  const requestId = useRef(0);
  // 끊겨 있다가 "ok" 가 되면 알린다. 처음 확인이 "ok" 인 것은 복구가 아니다.
  const lastSettled = useRef<HealthStatus>("checking");

  const apply = useCallback((next: HealthStatus) => {
    const prev = lastSettled.current;
    lastSettled.current = next;
    if (next === "ok" && (prev === "backend_down" || prev === "vllm_unreachable")) showToast(RECONNECTED_TOAST);
    setStatus(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const id = ++requestId.current;
      const next = await checkOnce();
      if (cancelled || id !== requestId.current) return;
      apply(next);
    }

    let interval: ReturnType<typeof setInterval> | undefined;
    const pause = () => {
      clearInterval(interval);
      interval = undefined;
    };
    const resume = () => {
      if (interval === undefined) interval = setInterval(run, POLL_INTERVAL_MS);
    };
    function handleVisibility() {
      if (document.hidden) {
        pause();
      } else {
        void run();
        resume();
      }
    }

    void run();
    if (!document.hidden) resume();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      pause();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [apply]);

  const retry = useCallback(() => {
    const id = ++requestId.current;
    setRetrying(true);
    void checkOnce().then((next) => {
      // 그사이 주기 확인이 새로 돌았으면 그 결과가 더 새롭다. 단추는 어느 쪽이든 풀어 준다.
      setRetrying(false);
      if (id === requestId.current) apply(next);
    });
  }, [apply]);

  return { status, retrying, retry };
}
