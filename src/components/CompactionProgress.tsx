import type { CompactionKind } from "../api/types";
import "./CompactionProgress.css";

/**
 * 컨텍스트 압축 진행률. 서버가 요약을 받아 쓰는 동안 compaction 이벤트로 흘려 주는
 * 값이고(server/chat/compactionProgress.ts), 그동안 입력창은 잠긴다.
 */
export function CompactionProgress({ kind, progress }: { kind: CompactionKind; progress: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const label = kind === "history" ? "이전 대화를 요약해 컨텍스트를 압축하는 중" : "수집한 도구 결과를 정리해 컨텍스트를 압축하는 중";
  return (
    <div className="compaction-progress" role="status" aria-live="polite">
      <div className="compaction-progress-head">
        <span className="compaction-progress-label">{label}…</span>
        <span className="compaction-progress-percent">{percent}%</span>
      </div>
      <div
        className="compaction-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="컨텍스트 압축 진행률"
      >
        <div className="compaction-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="compaction-progress-hint">압축이 끝나면 다시 입력할 수 있습니다. 다른 화면으로 옮겨도 압축은 계속됩니다.</p>
    </div>
  );
}
