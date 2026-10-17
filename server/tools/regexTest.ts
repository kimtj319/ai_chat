import type { ToolDefinition } from "./types.js";

// The ReDoS defense this tool depends on — and what it does not catch — is in
// regexSafety.ts. Read its header before touching the limits below.
import { assertPatternIsSafe } from "./regexSafety.js";

const MAX_PATTERN_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;
const DEFAULT_MAX_MATCHES = 20;
const MAX_MAX_MATCHES = 100;
const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

// --- The tool ------------------------------------------------------------------

interface MatchResult {
  match: string;
  index: number;
  groups: (string | null)[];
  namedGroups: Record<string, string | null>;
}

export const regexTestTool: ToolDefinition = {
  name: "regex_test",
  description:
    "Apply a regular expression to text and report each match: the matched substring, its index, numbered capture groups, and named groups. `pattern` is the regex body without surrounding slashes, `flags` any subset of \"gimsuy\". A pattern that could backtrack catastrophically is refused rather than run.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'The regular expression body, e.g. "\\\\b\\\\w+@\\\\w+\\\\.\\\\w+\\\\b".' },
      text: { type: "string", description: `Text to search (max ${MAX_TEXT_LENGTH} characters).` },
      flags: {
        type: "string",
        description: 'Optional flag letters, any subset of "gimsuy" (i=ignoreCase, m=multiline, s=dotAll, u=unicode, y=sticky). "g" is applied automatically either way.',
      },
      max_matches: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MAX_MATCHES,
        description: `Maximum number of match details to return (default ${DEFAULT_MAX_MATCHES}, max ${MAX_MAX_MATCHES}).`,
      },
    },
    required: ["pattern", "text"],
    additionalProperties: false,
  },
  async execute(args: { pattern: string; text: string; flags?: string; max_matches?: number }) {
    if (typeof args?.pattern !== "string" || args.pattern.length === 0) {
      throw new Error("pattern must be a non-empty string");
    }
    if (args.pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`pattern too long (${args.pattern.length} chars, limit ${MAX_PATTERN_LENGTH})`);
    }
    if (typeof args.text !== "string") throw new Error("text must be a string");
    if (args.text.length > MAX_TEXT_LENGTH) {
      throw new Error(`text too long (${args.text.length} chars, limit ${MAX_TEXT_LENGTH})`);
    }
    const flags = args.flags ?? "";
    if (typeof flags !== "string") throw new Error("flags must be a string");
    for (const ch of flags) {
      if (!ALLOWED_FLAGS.has(ch)) {
        throw new Error(`Unsupported flag "${ch}" — only letters from "gimsuy" are allowed`);
      }
    }
    if (new Set(flags).size !== flags.length) {
      throw new Error(`Duplicate flag in "${flags}"`);
    }
    let maxMatches = DEFAULT_MAX_MATCHES;
    if (args.max_matches !== undefined) {
      if (!Number.isInteger(args.max_matches) || args.max_matches < 1 || args.max_matches > MAX_MAX_MATCHES) {
        throw new Error(`max_matches must be an integer between 1 and ${MAX_MAX_MATCHES}`);
      }
      maxMatches = args.max_matches;
    }

    assertPatternIsSafe(args.pattern, flags.includes("i"));

    let re: RegExp;
    try {
      re = new RegExp(args.pattern, flags.includes("g") ? flags : flags + "g");
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }

    const matches: MatchResult[] = [];
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.text)) !== null) {
      count++;
      if (matches.length < maxMatches) {
        const groups = m.slice(1).map((g) => g ?? null);
        const namedGroups: Record<string, string | null> = {};
        if (m.groups) {
          for (const [k, v] of Object.entries(m.groups)) namedGroups[k] = v ?? null;
        }
        matches.push({ match: m[0], index: m.index, groups, namedGroups });
      }
      if (m[0].length === 0) re.lastIndex++; // avoid an infinite loop on zero-length matches
    }

    return { matched: count > 0, count, matches, truncated: count > matches.length };
  },
};
