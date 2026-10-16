import type { ToolContext, ToolDefinition } from "./types.js";
import { config } from "../config.js";

export interface ToolRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/** Same cap every tool result gets, for results that arrive from elsewhere (the user's browser). */
export function truncateToolResult(value: unknown): unknown {
  // 빈 결과는 그대로. truncate 는 JSON 으로 셀 수 있는 값만 받는다(undefined 면 던진다).
  return value === undefined ? undefined : truncate(value);
}

function truncate(value: unknown): unknown {
  const asString = typeof value === "string" ? value : JSON.stringify(value);
  const buf = Buffer.from(asString, "utf8");
  if (buf.byteLength <= config.toolMaxResultBytes) return value;
  const truncated = buf.subarray(0, config.toolMaxResultBytes).toString("utf8");
  return typeof value === "string" ? `${truncated}\n...[truncated]` : { truncated: true, preview: `${truncated}...[truncated]` };
}

function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 200 ? `${json.slice(0, 200)}...` : json;
  } catch {
    return String(args);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Runs a tool with a hard timeout (TOOL_TIMEOUT_MS, 10s by default), result
 * truncation at TOOL_MAX_RESULT_BYTES (100KB by default), and a log line.
 * Never throws.
 */
export async function runTool(tool: ToolDefinition, args: unknown, ctx?: ToolContext): Promise<ToolRunResult> {
  const start = Date.now();
  const argsSummary = summarizeArgs(args);
  try {
    const result = await withTimeout(tool.execute(args, ctx), config.toolTimeoutMs, tool.name);
    const durationMs = Date.now() - start;
    console.log(`[tool] ${tool.name} ok args=${argsSummary} durationMs=${durationMs}`);
    return { ok: true, result: truncate(result), durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tool] ${tool.name} FAIL args=${argsSummary} durationMs=${durationMs} error=${message}`);
    return { ok: false, error: message, durationMs };
  }
}
