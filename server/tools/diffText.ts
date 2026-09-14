import type { ToolDefinition } from "./types.js";

const MAX_LINES = 2_000;
const CONTEXT_LINES = 2;

interface DiffOp {
  type: "equal" | "added" | "removed";
  line: string;
}

/** Standard O(n*m) LCS line diff — fine at the MAX_LINES cap (~4M-cell table, well under the 10s tool budget). */
function diffLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", line: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "removed", line: before[i]! });
      i++;
    } else {
      ops.push({ type: "added", line: after[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "removed", line: before[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: "added", line: after[j]! });
    j++;
  }
  return ops;
}

/**
 * Collapse long runs of unchanged lines to a hidden-count placeholder,
 * keeping a couple of lines of context around each change — like a unified
 * diff's context window, so a long mostly-unchanged document stays compact.
 */
function compact(ops: DiffOp[]): unknown[] {
  const out: unknown[] = [];
  let run: DiffOp[] = [];
  let seenChange = false;

  const flushRun = (isTrailing: boolean) => {
    if (run.length === 0) return;
    const isLeading = !seenChange;
    if (run.length <= CONTEXT_LINES * 2) {
      for (const o of run) out.push({ type: o.type, line: o.line });
    } else {
      const head = isLeading ? [] : run.slice(0, CONTEXT_LINES);
      const tail = isTrailing ? [] : run.slice(-CONTEXT_LINES);
      const hiddenLines = run.length - head.length - tail.length;
      for (const o of head) out.push({ type: o.type, line: o.line });
      out.push({ type: "context", hiddenLines });
      for (const o of tail) out.push({ type: o.type, line: o.line });
    }
    run = [];
  };

  for (const op of ops) {
    if (op.type === "equal") {
      run.push(op);
    } else {
      flushRun(false);
      out.push({ type: op.type, line: op.line });
      seenChange = true;
    }
  }
  flushRun(true);
  return out;
}

export const diffTextTool: ToolDefinition = {
  name: "diff_text",
  description:
    'Compare two texts line-by-line and return what was added, removed, and unchanged (long unchanged runs are ' +
    'collapsed to a count, keeping a couple of lines of context). Use this to answer "what changed between these ' +
    "two versions\" precisely instead of eyeballing it.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      before: { type: "string", description: "Original text." },
      after: { type: "string", description: "Modified text." },
    },
    required: ["before", "after"],
    additionalProperties: false,
  },
  async execute(args: { before: string; after: string }) {
    if (typeof args?.before !== "string" || typeof args?.after !== "string") {
      throw new Error("before and after must both be strings");
    }
    const beforeLines = args.before.split("\n");
    const afterLines = args.after.split("\n");
    if (beforeLines.length > MAX_LINES || afterLines.length > MAX_LINES) {
      throw new Error(`Too many lines (limit ${MAX_LINES} per side) — shorten the input.`);
    }
    const ops = diffLines(beforeLines, afterLines);
    const linesAdded = ops.filter((o) => o.type === "added").length;
    const linesRemoved = ops.filter((o) => o.type === "removed").length;
    const linesUnchanged = ops.filter((o) => o.type === "equal").length;
    return {
      linesAdded,
      linesRemoved,
      linesUnchanged,
      identical: linesAdded === 0 && linesRemoved === 0,
      diff: compact(ops),
    };
  },
};
