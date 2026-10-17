import { useEffect, useState } from "react";
import type { ClientChatMessage } from "../state/types";
import "./ThinkingPanel.css";

interface ThinkingPanelProps {
  message: ClientChatMessage;
  /**
   * 이 턴이 생각하는지(추론 수준이 'off' 가 아닌지). 알면 생각이 도착하기 전부터
   * 머리줄을 보이고, 모르면 생각이 실제로 시작된 뒤에만 보인다.
   */
  expectsReasoning?: boolean;
}

/** 첫 reasoning·첫 content 가 온 시각(epoch ms). 스트림 쪽(WP7)이 채우는 클라이언트 전용 값. */
type ReasoningTimes = { reasoningStartedAt?: number; reasoningEndedAt?: number };

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function formatSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
}

export function ThinkingPanel({ message, expectsReasoning }: ThinkingPanelProps) {
  // Always starts collapsed. While the model is thinking the row just
  // shimmers; the reasoning itself is only revealed when the user asks for
  // it by clicking. Nothing expands on its own.
  const [expanded, setExpanded] = useState(false);
  const { reasoningStartedAt: startedAt, reasoningEndedAt: endedAt } = message as ClientChatMessage & ReasoningTimes;
  const reasoning = message.reasoning ?? "";
  const hasReasoning = reasoning.trim().length > 0;
  const streaming = Boolean(message.streaming);
  const isThinking = streaming && endedAt === undefined && message.content.trim().length === 0;

  // 생각하는 동안만 1초마다 다시 그린다 — 머리줄의 초가 흐르게.
  const ticking = isThinking && startedAt !== undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const visible = hasReasoning || (streaming && (startedAt !== undefined || (Boolean(expectsReasoning) && isThinking)));
  if (!visible) return null;

  let header;
  if (isThinking) {
    header =
      startedAt !== undefined ? (
        <>
          <span className="thinking-shimmer">생각하는 중</span>
          {/* 매초 바뀌는 부분은 화면 읽기 프로그램이 매번 읽지 않게 숨긴다. */}
          <span className="thinking-elapsed" aria-hidden="true">
            {" · "}
            {formatSeconds(Math.max(0, Math.floor((now - startedAt) / 1000)))}
          </span>
        </>
      ) : (
        <span className="thinking-shimmer">생각하는 중…</span>
      );
  } else if (startedAt !== undefined && endedAt !== undefined) {
    header = <span className="thinking-elapsed">{formatSeconds(Math.max(1, Math.round((endedAt - startedAt) / 1000)))} 동안 생각함</span>;
  } else {
    header = "생각 과정";
  }

  return (
    <div className="thinking-panel">
      <button
        type="button"
        className="thinking-panel-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        // 생각이 아직 한 글자도 없으면 펼쳐도 보일 것이 없다.
        disabled={!hasReasoning}
      >
        <span className={`thinking-caret${expanded ? " open" : ""}`}>
          <ChevronIcon />
        </span>
        <span>{header}</span>
      </button>
      <div className={`thinking-panel-collapse${expanded ? " expanded" : ""}`}>
        <div className="thinking-panel-body">{reasoning}</div>
      </div>
    </div>
  );
}
