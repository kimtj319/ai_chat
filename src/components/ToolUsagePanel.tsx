import { useState } from "react";
import type { ClientChatMessage } from "../state/types";
import { toolUsageSummary, type ToolCallStatus } from "../state/toolCopy";
import { ToolCallBlock } from "./ToolCallBlock";
import { ChevronRightIcon } from "./icons";
import "./ToolUsagePanel.css";

interface ToolUsagePanelProps {
  message: ClientChatMessage;
  /** MCP 서버 slug → 표시 이름. 있으면 "<이름> 사용", 없으면 '도구 사용'. */
  mcpServerNames?: Record<string, string>;
}

/**
 * Collapsible wrapper around a turn's tool calls, sitting directly under the
 * thinking panel and behaving the same way: always starts collapsed, shimmers
 * while a call is still running, and only reveals the calls when the user
 * clicks. Keeps the transcript readable when a turn makes several calls.
 */
export function ToolUsagePanel({ message, mcpServerNames }: ToolUsagePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const toolCalls = message.toolCalls ?? [];

  if (toolCalls.length === 0) return null;

  const resultFor = (id: string) => ({
    live: message.liveToolResults?.find((r) => r.id === id),
    final: message.toolResults?.find((r) => r.id === id),
  });

  const statuses: ToolCallStatus[] = toolCalls.map((c) => {
    const { live, final } = resultFor(c.id);
    const result = final ?? live;
    return result ? (result.ok ? "ok" : "fail") : "pending";
  });

  // One line in the user's words — what was done and for what — without
  // having to open the panel. Function names live in the expanded blocks.
  const summary = toolUsageSummary(toolCalls, statuses, mcpServerNames);

  return (
    <div className="tool-usage-panel">
      <button
        type="button"
        className="tool-usage-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`tool-usage-caret${expanded ? " open" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className="tool-usage-label">
          {summary.running ? <span className="thinking-shimmer">{summary.text}</span> : summary.text}
        </span>
      </button>

      <div className={`tool-usage-collapse${expanded ? " expanded" : ""}`}>
        <div className="tool-usage-body">
          {toolCalls.map((call) => {
            const { live, final } = resultFor(call.id);
            return (
              <ToolCallBlock
                key={call.id}
                call={call}
                liveResult={live}
                finalResult={final}
                mcpServerNames={mcpServerNames}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
