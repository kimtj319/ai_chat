import { useState } from "react";
import type { ClientChatMessage } from "../state/types";
import { ToolCallBlock } from "./ToolCallBlock";
import "./ToolUsagePanel.css";

interface ToolUsagePanelProps {
  message: ClientChatMessage;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * Collapsible wrapper around a turn's tool calls, sitting directly under the
 * thinking panel and behaving the same way: always starts collapsed, shimmers
 * while a call is still running, and only reveals the calls when the user
 * clicks. Keeps the transcript readable when a turn makes several calls.
 */
export function ToolUsagePanel({ message }: ToolUsagePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const toolCalls = message.toolCalls ?? [];

  if (toolCalls.length === 0) return null;

  const resultFor = (id: string) => ({
    live: message.liveToolResults?.find((r) => r.id === id),
    final: message.toolResults?.find((r) => r.id === id),
  });

  const running = toolCalls.filter((c) => {
    const { live, final } = resultFor(c.id);
    return !final && !live;
  }).length;
  const failed = toolCalls.filter((c) => {
    const { live, final } = resultFor(c.id);
    return final ? !final.ok : live ? !live.ok : false;
  }).length;

  // One line that says what happened without having to open the panel.
  const summary =
    running > 0
      ? `도구 사용 중… (${toolCalls.length}건)`
      : failed > 0
        ? `도구 사용 ${toolCalls.length}건 · 실패 ${failed}건`
        : `도구 사용 ${toolCalls.length}건`;

  return (
    <div className="tool-usage-panel">
      <button
        type="button"
        className="tool-usage-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`tool-usage-caret${expanded ? " open" : ""}`}>
          <ChevronIcon />
        </span>
        <span className="tool-usage-label">
          {running > 0 ? <span className="thinking-shimmer">{summary}</span> : summary}
        </span>
        <span className="tool-usage-names">{toolCalls.map((c) => c.name).join(", ")}</span>
      </button>

      <div className={`tool-usage-collapse${expanded ? " expanded" : ""}`}>
        <div className="tool-usage-body">
          {toolCalls.map((call) => {
            const { live, final } = resultFor(call.id);
            return <ToolCallBlock key={call.id} call={call} liveResult={live} finalResult={final} />;
          })}
        </div>
      </div>
    </div>
  );
}
