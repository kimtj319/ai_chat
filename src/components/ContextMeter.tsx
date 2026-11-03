import { useEffect, useId, useRef, useState } from "react";
import type { ContextUsageResponse } from "../api/types";
import { getContextUsage } from "../api/client";
import { useDismiss } from "../hooks/useDismiss";
import { meterView, type LiveContext } from "../state/contextMeter";
import "./ContextMeter.css";

interface ContextMeterProps {
  conversationId: string;
  model: string;
  /** Changes whenever the history the next turn sends may have changed (a new answer, a compaction). */
  revision: string;
  /** While a turn streams or compacts nothing is fetched; it is measured again afterwards. */
  paused: boolean;
  /** Mid-turn, the size of the request each round sends — shown instead, as it happens. */
  live: LiveContext | null;
}

const RING = 2 * Math.PI * 8;

/**
 * 입력창 옆 컨텍스트 사용률. 다음 질문이 실제로 보낼 기록을 지금 고른 모델로 잰 값이라
 * (server/chat/contextUsage.ts) 모델을 바꾸면 그 모델 기준으로 다시 잰다. 답변 중에는
 * 라운드마다 서버가 알려 주는 실제 요청 크기(context 이벤트)를 그대로 보인다.
 */
export function ContextMeter({ conversationId, model, revision, paused, live }: ContextMeterProps) {
  const [usage, setUsage] = useState<ContextUsageResponse | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useDismiss(open, boxRef, () => setOpen(false), { escape: true });

  // 다른 대화로 옮기면 앞 대화의 값이 잠깐이라도 비치지 않게 비우고, 열려 있던 설명도
  // 닫는다 — 보이지 않는 채 열려 Esc 를 가로채거나, 새 값이 오면 저절로 펼쳐지지 않게.
  useEffect(() => {
    setUsage(null);
    setOpen(false);
  }, [conversationId]);

  useEffect(() => {
    // model 이 비면(아직 고른 적 없는 새 대화) 서버가 그 대화가 실제로 쓸 모델로 잰다.
    if (paused) return;
    let live = true;
    getContextUsage(conversationId, model)
      .then((next) => {
        if (live) setUsage(next);
      })
      .catch(() => {
        // 재는 데 실패해도 입력은 막지 않는다 — 다음 답이 끝나면 다시 잰다.
      });
    return () => {
      live = false;
    };
  }, [conversationId, model, revision, paused]);

  if (!usage && !live) return null;
  const view = meterView(usage, model, live);
  const filled = view.percent === null ? 0 : (view.percent / 100) * RING;
  const label = view.percent === null ? "컨텍스트 사용량" : `컨텍스트 ${view.percent}% 사용`;

  return (
    <div className="context-meter" ref={boxRef} data-tone={view.tone}>
      <button
        type="button"
        className="context-meter-button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        data-tooltip={open ? undefined : label}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="context-meter-ring" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="8" className="context-meter-track" />
          <circle cx="10" cy="10" r="8" className="context-meter-fill" strokeDasharray={`${filled} ${RING}`} />
        </svg>
        <span className="context-meter-text">{view.short}</span>
      </button>
      {open && (
        <div className="context-meter-panel" id={panelId} role="status">
          {view.detail.split("\n").map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
