import type { ToolDefinition } from "./types.js";

/**
 * DEFENSE-IN-DEPTH AGAINST CATASTROPHIC BACKTRACKING — read before touching this file.
 *
 * A user-supplied regular expression runs in THIS process, on the main thread. The
 * tool runner (server/tools/runner.ts) wraps every tool call in a 10s `setTimeout`
 * race, but that is useless here: `RegExp.prototype.exec` is a synchronous, blocking
 * call into V8's native regex engine. It does not yield to the event loop, so the
 * timer callback that would "cancel" it can never fire until `exec` itself returns —
 * for a truly catastrophic pattern, that's effectively never. A hung regex hangs the
 * whole server, not just this request. So the timeout is not a defense here at all;
 * everything below is.
 *
 * Two independent, complementary mitigations:
 *
 * 1. STATIC REJECTION (assertPatternIsSafe, below). We parse the pattern with a small
 *    hand-rolled regex-of-a-regex (PatternParser) into groups/atoms/quantifiers, then
 *    reject a pattern if any *repeated group* (quantified with an unbounded `*`, `+`,
 *    or `{n,}`) either:
 *      a) contains another unbounded-repeated atom anywhere inside it — the classic
 *         "nested quantifier" shape, e.g. `(a+)+`, `(a*)*`, `(\d+\s*)+`; or
 *      b) has alternation branches whose possible starting characters overlap, e.g.
 *         `(a|a)+`, `(a|ab)+` — the "ambiguous alternation" shape, where the engine
 *         can partition the same input among the branches in exponentially many ways.
 *    Overlap is decided with a conservative FIRST-character-set approximation
 *    (firstSetOfBranch/firstSetOfNode): anything we can't pin down precisely — `.`,
 *    `\d`/`\w`/`\s` and their negations, `\p{...}`, negated character classes, wide
 *    character ranges, a branch that can match empty — is treated as "ANY" and
 *    therefore as overlapping with everything. That means we over-reject (some safe
 *    patterns using those constructs inside a repeated alternation will be refused)
 *    rather than under-reject. That trade-off is deliberate.
 *
 *    WHAT THIS DOES NOT CATCH: this is a heuristic on two known dangerous *shapes*,
 *    not a proof of linear-time behavior. It will not catch every ReDoS-capable
 *    pattern — notably, backreference-driven blowups (e.g. `(a+)\1+` style patterns)
 *    and more exotic constructions aren't analyzed at all. If our lightweight parser
 *    can't make sense of a pattern's structure (a construct it doesn't model), it
 *    gives up SILENTLY and lets the real `RegExp` constructor be the only check —
 *    fine when the pattern is simply invalid syntax (RegExp will throw), but it means
 *    a valid-but-exotic pattern our parser trips on is not analyzed for danger.
 *
 * 2. BOUNDED INPUT (MAX_TEXT_LENGTH, MAX_PATTERN_LENGTH). This is explicitly a
 *    secondary, limited mitigation, not a guarantee. Catastrophic backtracking is
 *    exponential in the length of the offending portion of the input — a pattern
 *    that truly has this problem can already take an unreasonable amount of time on
 *    an input just tens of characters long. Capping text at a few thousand characters
 *    does NOT make a genuinely catastrophic pattern that slips past #1 safe; it only
 *    bounds the damage for patterns that are merely polynomial-slow (quadratic-ish
 *    scans), and it stops a small mistake in #1 from being amplified by a huge input.
 *    Do not read this cap as "therefore any pattern is fine up to this length."
 */

const MAX_PATTERN_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;
const DEFAULT_MAX_MATCHES = 20;
const MAX_MAX_MATCHES = 100;
const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

// --- A minimal regex-of-a-regex parser -------------------------------------------
// Just enough structure to see groups, quantifiers, alternation, and character
// classes. It is deliberately lenient: anything it doesn't recognize falls back to
// being treated as a literal character rather than throwing, so we don't crash on
// constructs we simply don't model (see the file header for what that costs us).

interface Quant {
  min: number;
  max: number; // Infinity = unbounded
}

interface PNode {
  kind: "literal" | "class" | "dot" | "escape" | "group";
  char?: string; // literal
  escape?: string; // the character(s) after the backslash
  classContent?: string; // raw text between [ and ], escapes intact
  classNegate?: boolean;
  branches?: PNode[][]; // group: one array of nodes per alternative
  quant?: Quant;
}

class PatternParser {
  private i = 0;
  constructor(private src: string) {}

  parse(): PNode[][] {
    const branches = this.parseAlternation();
    if (this.i < this.src.length) {
      throw new Error(`Unexpected character at position ${this.i}`);
    }
    return branches;
  }

  private parseAlternation(): PNode[][] {
    const branches: PNode[][] = [this.parseSequence()];
    while (this.src[this.i] === "|") {
      this.i++;
      branches.push(this.parseSequence());
    }
    return branches;
  }

  private parseSequence(): PNode[] {
    const nodes: PNode[] = [];
    while (this.i < this.src.length && this.src[this.i] !== "|" && this.src[this.i] !== ")") {
      nodes.push(this.parseQuantified());
    }
    return nodes;
  }

  private parseQuantified(): PNode {
    const atom = this.parseAtom();
    atom.quant = this.parseQuantifier();
    return atom;
  }

  private parseQuantifier(): Quant | undefined {
    const c = this.src[this.i];
    if (c === "*") {
      this.i++;
      this.skipLazy();
      return { min: 0, max: Infinity };
    }
    if (c === "+") {
      this.i++;
      this.skipLazy();
      return { min: 1, max: Infinity };
    }
    if (c === "?") {
      this.i++;
      this.skipLazy();
      return { min: 0, max: 1 };
    }
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
      if (m) {
        this.i += m[0].length;
        this.skipLazy();
        const min = parseInt(m[1]!, 10);
        const max = m[2] === undefined ? min : m[3] === "" ? Infinity : parseInt(m[3]!, 10);
        return { min, max };
      }
      // `{` that isn't a valid {m}/{m,}/{m,n} quantifier is just a literal char — handled in parseAtom.
    }
    return undefined;
  }

  private skipLazy(): void {
    if (this.src[this.i] === "?") this.i++;
  }

  private parseAtom(): PNode {
    const c = this.src[this.i];
    if (c === "(") {
      this.i++;
      if (this.src[this.i] === "?") {
        if (this.src[this.i + 1] === "<" && this.src[this.i + 2] !== "=" && this.src[this.i + 2] !== "!") {
          // Named group (?<name> ... skip up to and including '>'.
          const close = this.src.indexOf(">", this.i);
          if (close === -1) throw new Error("Unterminated named group");
          this.i = close + 1;
        } else {
          // (?: or (?= or (?! or (?<= or (?<!
          this.i += this.src[this.i + 1] === "<" ? 3 : 2;
        }
      }
      const branches = this.parseAlternation();
      if (this.src[this.i] !== ")") throw new Error("Unterminated group");
      this.i++;
      return { kind: "group", branches };
    }
    if (c === "[") {
      this.i++;
      let negate = false;
      if (this.src[this.i] === "^") {
        negate = true;
        this.i++;
      }
      let content = "";
      if (this.src[this.i] === "]") {
        content += "]";
        this.i++;
      }
      while (this.i < this.src.length && this.src[this.i] !== "]") {
        if (this.src[this.i] === "\\") {
          content += this.src.slice(this.i, this.i + 2);
          this.i += 2;
        } else {
          content += this.src[this.i];
          this.i++;
        }
      }
      if (this.src[this.i] !== "]") throw new Error("Unterminated character class");
      this.i++;
      return { kind: "class", classContent: content, classNegate: negate };
    }
    if (c === ".") {
      this.i++;
      return { kind: "dot" };
    }
    if (c === "\\") {
      const esc = this.src[this.i + 1];
      if (esc === undefined) throw new Error("Trailing backslash");
      this.i += 2;
      return { kind: "escape", escape: esc };
    }
    this.i++;
    return { kind: "literal", char: c! };
  }
}

// --- Danger detection --------------------------------------------------------------

function isUnbounded(q: Quant | undefined): boolean {
  return !!q && q.max === Infinity;
}

/**
 * A quantifier that can run the group more than once, whether or not it has an
 * upper bound.
 *
 * `isUnbounded` alone was not enough, and this is not hypothetical: `(.*a){25}`
 * has a bounded quantifier, so it was accepted and then hung the process for
 * over ten seconds on sixty characters (measured 2026-09-12). Twenty-five
 * repetitions of a group containing `.*` blows up exponentially just as `+`
 * does; the upper bound only caps the exponent, and 2^25 is already far past
 * the point where it matters.
 */
function repeatsMoreThanOnce(q: Quant | undefined): boolean {
  return !!q && q.max > 1;
}

/** True if any node anywhere in this subtree carries an unbounded quantifier. */
function containsUnboundedQuantifier(nodes: PNode[]): boolean {
  for (const n of nodes) {
    if (isUnbounded(n.quant)) return true;
    if (n.kind === "group" && n.branches!.some((b) => containsUnboundedQuantifier(b))) return true;
  }
  return false;
}

// A branch's possible starting characters. "ANY" means "we can't or won't pin this
// down precisely" and is treated as overlapping with every other set (see header).
type FirstSet = "ANY" | Set<string>;

const WIDE_ESCAPES = /[dwsDWSpP]/; // \d \w \s and negations, and \p{...}/\P{...} property escapes

function foldChar(c: string, ignoreCase: boolean, out: Set<string>): void {
  out.add(c);
  if (ignoreCase) {
    out.add(c.toLowerCase());
    out.add(c.toUpperCase());
  }
}

function firstSetOfClass(content: string, negate: boolean, ignoreCase: boolean): FirstSet {
  if (negate) return "ANY";
  const chars = new Set<string>();
  let i = 0;
  while (i < content.length) {
    const c = content[i]!;
    if (c === "\\") {
      const esc = content[i + 1];
      if (esc === undefined) break;
      if (WIDE_ESCAPES.test(esc)) return "ANY";
      foldChar(esc, ignoreCase, chars);
      i += 2;
      continue;
    }
    if (content[i + 1] === "-" && i + 2 < content.length && content[i + 2] !== "\\") {
      const toChar = content[i + 2]!;
      const span = toChar.codePointAt(0)! - c.codePointAt(0)!;
      if (span >= 0 && span <= 64) {
        for (let cc = c.codePointAt(0)!; cc <= toChar.codePointAt(0)!; cc++) {
          foldChar(String.fromCodePoint(cc), ignoreCase, chars);
        }
        i += 3;
        continue;
      }
      return "ANY"; // wide range — don't try to enumerate it
    }
    foldChar(c, ignoreCase, chars);
    i += 1;
  }
  return chars;
}

function firstSetOfEscape(esc: string, ignoreCase: boolean): FirstSet {
  if (WIDE_ESCAPES.test(esc)) return "ANY";
  const literal: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", "0": "\0" };
  const chars = new Set<string>();
  foldChar(literal[esc] ?? esc, ignoreCase, chars);
  return chars;
}

function firstSetOfNode(node: PNode, ignoreCase: boolean): FirstSet {
  switch (node.kind) {
    case "literal": {
      const chars = new Set<string>();
      foldChar(node.char!, ignoreCase, chars);
      return chars;
    }
    case "dot":
      return "ANY";
    case "escape":
      return firstSetOfEscape(node.escape!, ignoreCase);
    case "class":
      return firstSetOfClass(node.classContent!, node.classNegate!, ignoreCase);
    case "group": {
      const sets = node.branches!.map((b) => firstSetOfBranch(b, ignoreCase));
      if (sets.some((s) => s === "ANY")) return "ANY";
      const union = new Set<string>();
      for (const s of sets as Set<string>[]) for (const c of s) union.add(c);
      return union;
    }
  }
}

/** Only looks at the first atom of the branch; an optional or empty first atom is
 * conservatively treated as "ANY" rather than looking further ahead (see header). */
function firstSetOfBranch(seq: PNode[], ignoreCase: boolean): FirstSet {
  const first = seq[0];
  if (first === undefined) return "ANY"; // can match empty
  if (first.quant && first.quant.min === 0) return "ANY"; // optional first atom
  return firstSetOfNode(first, ignoreCase);
}

function setsOverlap(a: FirstSet, b: FirstSet): boolean {
  if (a === "ANY" || b === "ANY") return true;
  for (const c of a) if (b.has(c)) return true;
  return false;
}

function branchesOverlap(branches: PNode[][], ignoreCase: boolean): boolean {
  const sets = branches.map((b) => firstSetOfBranch(b, ignoreCase));
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      if (setsOverlap(sets[a]!, sets[b]!)) return true;
    }
  }
  return false;
}

/** Walks the whole tree looking for a repeated group that is dangerous. Returns a
 * human-readable reason, or undefined if nothing suspicious was found. */
function findDanger(nodes: PNode[], ignoreCase: boolean): string | undefined {
  for (const n of nodes) {
    if (n.kind === "group") {
      // Nesting is dangerous for any repeat count above one, so this arm uses
      // the wider test; the overlapping-alternatives arm below stays on the
      // unbounded test, where a small bounded repeat is not worth refusing.
      if (repeatsMoreThanOnce(n.quant)) {
        for (const branch of n.branches!) {
          if (containsUnboundedQuantifier(branch)) {
            return "a repeated group contains another unbounded repetition inside it (e.g. (a+)+ or (.*a){25}) — this can take exponential time to fail to match";
          }
        }
      }
      if (isUnbounded(n.quant)) {
        if (n.branches!.length > 1 && branchesOverlap(n.branches!, ignoreCase)) {
          return "a repeated group has alternatives that can match the same text (e.g. (a|a)+ or (a|ab)+) — this can take exponential time to fail to match";
        }
      }
      for (const b of n.branches!) {
        const reason = findDanger(b, ignoreCase);
        if (reason) return reason;
      }
    }
  }
  return undefined;
}

function assertPatternIsSafe(pattern: string, ignoreCase: boolean): void {
  let branches: PNode[][];
  try {
    branches = new PatternParser(pattern).parse();
  } catch {
    // We couldn't model this pattern's structure. Rather than guess, we let the real
    // RegExp constructor be the final word — it will reject genuinely invalid syntax,
    // and this is the known coverage gap documented at the top of this file.
    return;
  }
  const reason = findDanger(branches.flat(), ignoreCase);
  if (reason) {
    throw new Error(`Pattern rejected as unsafe: ${reason}. Rewrite it to remove the ambiguous repetition.`);
  }
}

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
