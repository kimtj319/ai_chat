import type { HealthStatus } from "../hooks/useHealthCheck";
import "./StatusBanner.css";

interface StatusBannerProps {
  status: HealthStatus;
  onRetry: () => void;
}

export function StatusBanner({ status, onRetry }: StatusBannerProps) {
  if (status === "checking" || status === "ok") return null;

  const message =
    status === "backend_down"
      ? "서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인하세요."
      : "vLLM 서버에 연결할 수 없습니다. 모델 서버 상태를 확인하세요.";

  return (
    <div className="status-banner">
      <span>{message}</span>
      <button type="button" className="btn btn-secondary status-banner-retry" onClick={onRetry}>
        다시 시도
      </button>
    </div>
  );
}
