import type { HealthStatus } from "../hooks/useHealthCheck";
import "./StatusBanner.css";

interface StatusBannerProps {
  status: HealthStatus;
  /** [지금 다시 시도] 로 시작한 확인이 도는 중. */
  retrying: boolean;
  onRetry: () => void;
}

/* 읽는 사람은 서버를 띄운 사람이 아니라 쓰는 사람이다 — 무엇이 안 되는지, 무엇을 하면
   되는지, 기다리면 어떻게 되는지만 말한다. */
const MESSAGES: Record<"backend_down" | "vllm_unreachable", string> = {
  backend_down: "AI Console에 연결할 수 없습니다. 네트워크를 확인해 주세요. 15초마다 다시 연결을 시도합니다.",
  vllm_unreachable: "모델 서버가 응답하지 않아 지금은 답변할 수 없습니다. 복구되면 이 안내가 사라집니다.",
};

export function StatusBanner({ status, retrying, onRetry }: StatusBannerProps) {
  if (status === "checking" || status === "ok") return null;

  return (
    <div className="status-banner" role="status">
      <span>{MESSAGES[status]}</span>
      <button
        type="button"
        className="btn btn-secondary status-banner-retry"
        onClick={onRetry}
        disabled={retrying}
        aria-busy={retrying || undefined}
      >
        {retrying ? "확인하는 중…" : "지금 다시 시도"}
      </button>
    </div>
  );
}
