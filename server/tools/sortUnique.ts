import type { ToolDefinition } from "./types.js";

const MAX_INPUT_LINES = 50_000;
const MAX_OUTPUT_LINES = 1_000;

interface Options {
  order: "asc" | "desc";
  numeric: boolean;
  ignoreCase: boolean;
}

/**
 * Splits text into lines, normalizing CRLF to LF first. A single trailing newline is
 * treated as a line terminator, not an extra blank line — "a\nb\n" is two lines, not
 * three — because that's the overwhelmingly common shape of real text and treating
 * it otherwise would silently inflate every count/sort by one phantom empty line.
 * Text with no trailing newline keeps its last line as-is; genuinely empty text
 * produces exactly one empty line.
 */
function splitLines(text: string, trim: boolean): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return trim ? lines.map((l) => l.trim()) : lines;
}

/** Ascending-sense comparison; compareLines flips the sign for "desc". Non-numeric
 * lines always sort after numeric ones when `numeric` is set, regardless of order —
 * "desc" reverses the numeric ordering, it doesn't move text lines to the front. */
function compareAscending(a: string, b: string, opts: Options): number {
  if (opts.numeric) {
    const na = a.trim() === "" ? NaN : Number(a);
    const nb = b.trim() === "" ? NaN : Number(b);
    const aOk = Number.isFinite(na);
    const bOk = Number.isFinite(nb);
    if (aOk && bOk) return na - nb;
    if (aOk !== bOk) return aOk ? -1 : 1;
    // both non-numeric: fall through to string comparison below
  }
  const x = opts.ignoreCase ? a.toLowerCase() : a;
  const y = opts.ignoreCase ? b.toLowerCase() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareLines(a: string, b: string, opts: Options): number {
  const cmp = compareAscending(a, b, opts);
  return opts.order === "desc" ? -cmp : cmp;
}

/** Deduplicates, keeping the first-seen original text for each case-folded key. */
function dedupeFirstSeen(lines: string[], ignoreCase: boolean): string[] {
  const seen = new Map<string, string>();
  for (const line of lines) {
    const key = ignoreCase ? line.toLowerCase() : line;
    if (!seen.has(key)) seen.set(key, line);
  }
  return [...seen.values()];
}

export const sortUniqueTool: ToolDefinition = {
  name: "sort_unique",
  description:
    "Sort, deduplicate or count the lines of a block of text, the equivalent of shell sort/uniq. \"sort\" keeps duplicates, \"unique\" returns distinct lines in sorted order, \"count\" returns each distinct line with how many times it occurred, most frequent first. Order, numeric, case folding and trimming are options.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to process, as newline-separated lines." },
      operation: {
        type: "string",
        enum: ["sort", "unique", "count"],
        description: 'One of "sort", "unique", or "count".',
      },
      order: { type: "string", enum: ["asc", "desc"], description: 'Sort direction (default "asc").' },
      numeric: { type: "boolean", description: "Compare lines as numbers instead of text (default false)." },
      ignore_case: { type: "boolean", description: "Fold case when comparing lines (default false)." },
      trim: { type: "boolean", description: "Trim leading/trailing whitespace from each line first (default true)." },
    },
    required: ["text", "operation"],
    additionalProperties: false,
  },
  async execute(args: {
    text: string;
    operation: "sort" | "unique" | "count";
    order?: "asc" | "desc";
    numeric?: boolean;
    ignore_case?: boolean;
    trim?: boolean;
  }) {
    if (typeof args?.text !== "string") throw new Error("text must be a string");
    if (args.operation !== "sort" && args.operation !== "unique" && args.operation !== "count") {
      throw new Error('operation must be "sort", "unique", or "count"');
    }
    if (args.order !== undefined && args.order !== "asc" && args.order !== "desc") {
      throw new Error('order must be "asc" or "desc"');
    }
    if (args.numeric !== undefined && typeof args.numeric !== "boolean") {
      throw new Error("numeric must be a boolean");
    }
    if (args.ignore_case !== undefined && typeof args.ignore_case !== "boolean") {
      throw new Error("ignore_case must be a boolean");
    }
    if (args.trim !== undefined && typeof args.trim !== "boolean") {
      throw new Error("trim must be a boolean");
    }

    const opts: Options = {
      order: args.order ?? "asc",
      numeric: args.numeric ?? false,
      ignoreCase: args.ignore_case ?? false,
    };
    const trim = args.trim ?? true;

    const lines = splitLines(args.text, trim);
    if (lines.length > MAX_INPUT_LINES) {
      throw new Error(`Too many lines (${lines.length}, limit ${MAX_INPUT_LINES}) — shorten the input.`);
    }

    if (args.operation === "sort") {
      const sorted = [...lines].sort((a, b) => compareLines(a, b, opts));
      return {
        operation: "sort" as const,
        totalLines: sorted.length,
        truncated: sorted.length > MAX_OUTPUT_LINES,
        lines: sorted.slice(0, MAX_OUTPUT_LINES),
      };
    }

    if (args.operation === "unique") {
      const distinct = dedupeFirstSeen(lines, opts.ignoreCase).sort((a, b) => compareLines(a, b, opts));
      return {
        operation: "unique" as const,
        totalLines: distinct.length,
        truncated: distinct.length > MAX_OUTPUT_LINES,
        lines: distinct.slice(0, MAX_OUTPUT_LINES),
      };
    }

    const counts = new Map<string, { line: string; count: number }>();
    for (const line of lines) {
      const key = opts.ignoreCase ? line.toLowerCase() : line;
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { line, count: 1 });
    }
    const entries = [...counts.values()].sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count; // most frequent first, always
      return compareLines(a.line, b.line, opts);
    });
    return {
      operation: "count" as const,
      totalLines: entries.length,
      truncated: entries.length > MAX_OUTPUT_LINES,
      counts: entries.slice(0, MAX_OUTPUT_LINES),
    };
  },
};
