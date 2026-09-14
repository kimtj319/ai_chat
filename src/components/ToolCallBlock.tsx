import type { ToolCall, ToolResult } from "../api/types";
import type { LiveToolResult } from "../state/types";
import "./ToolCallBlock.css";

interface ToolCallBlockProps {
  call: ToolCall;
  liveResult?: LiveToolResult;
  finalResult?: ToolResult;
}

function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Inline, first-class rendering of one tool call + its (eventual) result, used both while a message is still streaming and once it's persisted. */
export function ToolCallBlock({ call, liveResult, finalResult }: ToolCallBlockProps) {
  const status: "pending" | "ok" | "fail" = finalResult
    ? finalResult.ok
      ? "ok"
      : "fail"
    : liveResult
      ? liveResult.ok
        ? "ok"
        : "fail"
      : "pending";

  const durationMs = finalResult?.durationMs ?? liveResult?.durationMs;
  const errorText = finalResult?.error ?? liveResult?.error;
  const resultText = finalResult ? formatJson(finalResult.result) : (liveResult?.preview ?? null);

  return (
    <div className={`tool-call-block tool-call-block-${status}`}>
      <div className="tool-call-header">
        <span className="tool-call-status-dot" aria-hidden="true" />
        <span className="tool-call-name">{call.name}</span>
        <span className="tool-call-status-label">
          {status === "pending" ? "실행 중…" : status === "ok" ? "완료" : "실패"}
        </span>
        {durationMs != null && <span className="tool-call-duration">{durationMs.toLocaleString()}ms</span>}
      </div>

      <details className="tool-call-details">
        <summary>인자</summary>
        <pre className="tool-call-json">{formatJson(call.arguments)}</pre>
      </details>

      {resultText !== null && (
        <details className="tool-call-details">
          <summary>결과{finalResult ? "" : " (미리보기)"}</summary>
          <pre className="tool-call-json">{resultText}</pre>
        </details>
      )}

      {errorText && <p className="tool-call-error">{errorText}</p>}
    </div>
  );
}
