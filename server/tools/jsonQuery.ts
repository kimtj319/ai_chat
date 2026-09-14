import type { ToolDefinition } from "./types.js";

const MAX_INPUT_CHARS = 100_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Path grammar (deliberately small — the tool description below is the model's ONLY
 * spec for this, so it has to be both short and exact):
 *
 *   path    := segment ("." segment)*
 *   segment := "*" | key ("[" index "]")*
 *   key     := one or more characters other than "." "[" "]"
 *   index   := "*" | non-negative integer
 *
 * A bare "*" segment fans out over every value of the current *object*.
 * A "[*]" index fans out over every element of the current *array*.
 * There is no escaping — a key that itself needs to contain ".", "[" or "]" cannot
 * be expressed. That's an intentional trade for a grammar simple enough to hand to a
 * model in one paragraph, not an oversight.
 */

type Segment = { kind: "wildcard" } | { kind: "key"; key: string; brackets: BracketSpec[] };
type BracketSpec = { kind: "index"; index: number } | { kind: "wildcard" };

function parsePath(path: string): Segment[] {
  return path.split(".").map((raw, i) => parseSegment(raw, i, path));
}

function parseSegment(raw: string, position: number, fullPath: string): Segment {
  if (raw === "") {
    throw new Error(
      `Invalid path "${fullPath}": empty segment at position ${position} (check for "..", or a leading/trailing ".")`,
    );
  }
  if (raw === "*") return { kind: "wildcard" };

  const bracketStart = raw.indexOf("[");
  const key = bracketStart === -1 ? raw : raw.slice(0, bracketStart);
  let rest = bracketStart === -1 ? "" : raw.slice(bracketStart);
  if (key === "" || key.includes("]")) {
    throw new Error(`Invalid path segment "${raw}" in "${fullPath}": a key cannot be empty or contain "]"`);
  }

  const brackets: BracketSpec[] = [];
  while (rest.length > 0) {
    const m = /^\[(\*|\d+)\]/.exec(rest);
    if (!m) {
      throw new Error(
        `Invalid path segment "${raw}" in "${fullPath}": expected "[<index>]" or "[*]" but found "${rest}"`,
      );
    }
    brackets.push(m[1] === "*" ? { kind: "wildcard" } : { kind: "index", index: parseInt(m[1]!, 10) });
    rest = rest.slice(m[0].length);
  }
  return { kind: "key", key, brackets };
}

interface Hit {
  path: string;
  value: unknown;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array (${value.length} elements)`;
  return typeof value;
}

/**
 * Walks `value` through `segments` starting at `segIdx`, collecting every concrete
 * match into `hits`. A wildcard fans out into multiple branches; a branch that
 * dead-ends (wrong type, missing key, out-of-bounds index) just stops contributing
 * rather than aborting the whole query — `failures` records why, so that if NOTHING
 * matched at all we can point at a specific reason instead of just saying "no results".
 */
function walk(value: unknown, path: string, segments: Segment[], segIdx: number, hits: Hit[], failures: string[]): void {
  if (segIdx === segments.length) {
    hits.push({ path: path === "" ? "(root)" : path, value });
    return;
  }
  const seg = segments[segIdx]!;

  if (seg.kind === "wildcard") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      failures.push(`"*" at ${path || "(root)"} expects an object, found ${describe(value)}`);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, segments, segIdx + 1, hits, failures);
    }
    return;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failures.push(`key "${seg.key}" at ${path || "(root)"} expects an object, found ${describe(value)}`);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(value, seg.key)) {
    failures.push(`key "${seg.key}" not found at ${path || "(root)"}`);
    return;
  }
  const keyed = (value as Record<string, unknown>)[seg.key];
  const keyedPath = path ? `${path}.${seg.key}` : seg.key;
  applyBrackets(keyed, keyedPath, seg.brackets, 0, segments, segIdx + 1, hits, failures);
}

function applyBrackets(
  value: unknown,
  path: string,
  brackets: BracketSpec[],
  bIdx: number,
  segments: Segment[],
  segIdx: number,
  hits: Hit[],
  failures: string[],
): void {
  if (bIdx === brackets.length) {
    walk(value, path, segments, segIdx, hits, failures);
    return;
  }
  const b = brackets[bIdx]!;
  if (!Array.isArray(value)) {
    failures.push(`"[${b.kind === "wildcard" ? "*" : b.index}]" at ${path} expects an array, found ${describe(value)}`);
    return;
  }
  if (b.kind === "wildcard") {
    value.forEach((el, i) => applyBrackets(el, `${path}[${i}]`, brackets, bIdx + 1, segments, segIdx, hits, failures));
    return;
  }
  if (b.index < 0 || b.index >= value.length) {
    failures.push(`"[${b.index}]" at ${path} is out of bounds (array has ${value.length} elements)`);
    return;
  }
  applyBrackets(value[b.index], `${path}[${b.index}]`, brackets, bIdx + 1, segments, segIdx, hits, failures);
}

export const jsonQueryTool: ToolDefinition = {
  name: "json_query",
  description:
    "Extract values from a JSON document by path. Segments are separated by \".\"; a segment is a key optionally followed by \"[n]\" or \"[*]\", or a bare \"*\" for every value of an object. Examples: \"a.b.c\", \"items[0]\", \"items[*].name\", \"*.id\", \"matrix[0][1]\". Returns each value with the path it came from.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      data: { type: "string", description: "The JSON document to query, as text." },
      path: {
        type: "string",
        description: 'Path expression, e.g. "items[*].name". See the tool description for the full grammar.',
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: ["data", "path"],
    additionalProperties: false,
  },
  async execute(args: { data: string; path: string; limit?: number }) {
    if (typeof args?.data !== "string" || args.data.length === 0) {
      throw new Error("data must be a non-empty string containing JSON");
    }
    if (args.data.length > MAX_INPUT_CHARS) {
      throw new Error(`data too large (${args.data.length} chars, limit ${MAX_INPUT_CHARS})`);
    }
    if (typeof args.path !== "string" || args.path.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined) {
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
        throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
      limit = args.limit;
    }

    let data: unknown;
    try {
      data = JSON.parse(args.data);
    } catch (err) {
      throw new Error(`data is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const segments = parsePath(args.path);
    const hits: Hit[] = [];
    const failures: string[] = [];
    walk(data, "", segments, 0, hits, failures);

    if (hits.length === 0) {
      const reason = failures[0] ?? `path "${args.path}" matched nothing`;
      throw new Error(`No values matched: ${reason}`);
    }

    return {
      count: hits.length,
      truncated: hits.length > limit,
      results: hits.slice(0, limit),
    };
  },
};
