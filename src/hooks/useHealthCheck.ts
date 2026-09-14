import { useEffect, useRef, useState } from "react";
import { getHealth } from "../api/client";

export type HealthStatus = "checking" | "ok" | "vllm_unreachable" | "backend_down";

const POLL_INTERVAL_MS = 15000;

async function checkOnce(): Promise<HealthStatus> {
  try {
    const health = await getHealth();
    return health.vllm === "ok" ? "ok" : "vllm_unreachable";
  } catch {
    return "backend_down";
  }
}

export function useHealthCheck() {
  const [status, setStatus] = useState<HealthStatus>("checking");
  const requestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const id = ++requestId.current;

    async function run() {
      setStatus("checking");
      const next = await checkOnce();
      if (cancelled || id !== requestId.current) return;
      setStatus(next);
    }

    void run();
    const interval = setInterval(run, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const recheck = () => {
    requestId.current += 1;
    setStatus("checking");
    void checkOnce().then(setStatus);
  };

  return { status, recheck };
}
