import { useState } from "react";
import type { ClientChatMessage } from "../state/types";
import "./ThinkingPanel.css";

interface ThinkingPanelProps {
  message: ClientChatMessage;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function ThinkingPanel({ message }: ThinkingPanelProps) {
  // Always starts collapsed. While the model is thinking the row just
  // shimmers; the reasoning itself is only revealed when the user asks for
  // it by clicking. Nothing expands on its own.
  const [expanded, setExpanded] = useState(false);
  const reasoning = message.reasoning ?? "";

  if (reasoning.trim().length === 0) return null;

  const isThinking = Boolean(message.streaming) && message.content.trim().length === 0;

  return (
    <div className="thinking-panel">
      <button type="button" className="thinking-panel-toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className={`thinking-caret${expanded ? " open" : ""}`}>
          <ChevronIcon />
        </span>
        <span>{isThinking ? <span className="thinking-shimmer">생각하는 중…</span> : "생각 과정"}</span>
      </button>
      <div className={`thinking-panel-collapse${expanded ? " expanded" : ""}`}>
        <div className="thinking-panel-body">{reasoning}</div>
      </div>
    </div>
  );
}
