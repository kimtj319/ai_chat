import type { ToolDefinition } from "./types.js";

// Two strings can look pixel-identical in a chat window or a log viewer while
// having completely different bytes underneath — an invisible zero-width
// character slipped in by a copy-paste, a non-breaking space where a regular
// space was expected, or the same word stored as precomposed Hangul syllables
// in one place and decomposed jamo in another. Search engines built on exact
// or analyzed matching are exactly where this bites: two queries that "look
// the same" fail to match, or a dedup step doesn't dedup. This tool exists to
// make that invisible difference visible.

const MAX_INPUT_CHARS = 100_000;
const MAX_CHARACTERS_SHOWN = 200;

// Known zero-width / invisible-by-design code points. This is deliberately a
// curated list (rather than relying solely on the Unicode "Cf" general
// category) because Cf also contains some characters that are conventionally
// rendered with visible glyphs by many fonts; the entries below are the ones
// that are genuinely zero-width in virtually every renderer and are the usual
// suspects behind "these two strings look the same but don't match" bugs.
const ZERO_WIDTH_NAMES: Record<number, string> = {
  0x00ad: "SOFT HYPHEN",
  0x061c: "ARABIC LETTER MARK",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x2060: "WORD JOINER",
  0x2061: "FUNCTION APPLICATION",
  0x2062: "INVISIBLE TIMES",
  0x2063: "INVISIBLE SEPARATOR",
  0x2064: "INVISIBLE PLUS",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE (BOM)",
};

// A handful of "space-shaped" characters that are not U+0020 but often get
// pasted in from word processors, CJK IMEs, or web pages, and then silently
// fail to match a plain space in search or comparison. U+3000 in particular
// (the full-width/ideographic space) is common in Korean and Japanese text.
const UNUSUAL_SPACE_NAMES: Record<number, string> = {
  0x00a0: "NO-BREAK SPACE",
  0x1680: "OGHAM SPACE MARK",
  0x2000: "EN QUAD",
  0x2001: "EM QUAD",
  0x2002: "EN SPACE",
  0x2003: "EM SPACE",
  0x2004: "THREE-PER-EM SPACE",
  0x2005: "FOUR-PER-EM SPACE",
  0x2006: "SIX-PER-EM SPACE",
  0x2007: "FIGURE SPACE",
  0x2008: "PUNCTUATION SPACE",
  0x2009: "THIN SPACE",
  0x200a: "HAIR SPACE",
  0x202f: "NARROW NO-BREAK SPACE",
  0x205f: "MEDIUM MATHEMATICAL SPACE",
  0x3000: "IDEOGRAPHIC SPACE",
};

const VARIATION_SELECTOR_NAME = "VARIATION SELECTOR";

function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

const CONTROL_REGEX = /\p{Cc}/u;
// U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR -- compared by code
// point rather than matched with a regex literal, since a JS/TS regex
// literal is not allowed to contain a raw line-terminator character.
const LINE_SEPARATOR_CODE_POINT = 0x2028;
const PARAGRAPH_SEPARATOR_CODE_POINT = 0x2029;

function isControl(ch: string): boolean {
  return CONTROL_REGEX.test(ch);
}

function invisibleReason(ch: string, cp: number): string | undefined {
  if (isControl(ch)) {
    return cp <= 0x1f || cp === 0x7f ? "control character (C0)" : "control character (C1)";
  }
  if (ZERO_WIDTH_NAMES[cp]) return ZERO_WIDTH_NAMES[cp];
  if (isVariationSelector(cp)) return VARIATION_SELECTOR_NAME;
  if (cp === LINE_SEPARATOR_CODE_POINT) return "LINE SEPARATOR";
  if (cp === PARAGRAPH_SEPARATOR_CODE_POINT) return "PARAGRAPH SEPARATOR";
  if (cp !== 0x20 && UNUSUAL_SPACE_NAMES[cp]) return `unusual space (${UNUSUAL_SPACE_NAMES[cp]})`;
  return undefined;
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

// Hangul-specific ranges. A "syllable" (U+AC00-U+D7A3) is what NFC produces —
// one code point per displayed block. "Jamo" (the combining consonant/vowel
// blocks used by NFD, plus their two Unicode extension blocks) is what you get
// after decomposition — the same visual syllable spread across 2-3 code
// points. "Compatibility jamo" (U+3130-U+318F) is a third, separate thing:
// standalone letters (as typed by an IME before composition, or used for
// spelling out a single jamo) that do NOT combine into syllables under NFC.
function isHangulSyllable(cp: number): boolean {
  return cp >= 0xac00 && cp <= 0xd7a3;
}
function isHangulJamo(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xd7b0 && cp <= 0xd7ff);
}
function isHangulCompatJamo(cp: number): boolean {
  return cp >= 0x3130 && cp <= 0x318f;
}

export const unicodeInspectTool: ToolDefinition = {
  name: "unicode_inspect",
  description:
    "Inspect text at the Unicode level: per character the code point (U+XXXX), its UTF-8 byte length, and whether it is a control, zero-width or otherwise invisible character. Also reports all four normalization forms and which differ, and whether Hangul is precomposed or decomposed jamo. Use it when two strings look identical but do not match.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to inspect." },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(args: { text: string }) {
    if (typeof args?.text !== "string" || args.text.length === 0) {
      throw new Error("text must be a non-empty string");
    }
    if (args.text.length > MAX_INPUT_CHARS) {
      throw new Error(`text too large (${args.text.length} chars, limit ${MAX_INPUT_CHARS})`);
    }
    const text = args.text;

    // Splitting a string with the spread operator / Array.from iterates by
    // Unicode code point (not UTF-16 code unit), so surrogate pairs for
    // characters outside the Basic Multilingual Plane come out as one entry.
    const codePoints = Array.from(text);

    let syllableCount = 0;
    let jamoCount = 0;
    let compatJamoCount = 0;
    let invisibleCount = 0;
    for (const ch of codePoints) {
      const cp = ch.codePointAt(0)!;
      if (isHangulSyllable(cp)) syllableCount++;
      else if (isHangulJamo(cp)) jamoCount++;
      else if (isHangulCompatJamo(cp)) compatJamoCount++;
      if (invisibleReason(ch, cp)) invisibleCount++;
    }

    let hangulForm: string;
    if (syllableCount === 0 && jamoCount === 0 && compatJamoCount === 0) {
      hangulForm = "no Hangul characters detected";
    } else if (jamoCount > 0 && syllableCount === 0) {
      hangulForm = "decomposed (NFD-style combining jamo)";
    } else if (syllableCount > 0 && jamoCount === 0) {
      hangulForm = "precomposed (NFC-style syllables)";
    } else {
      hangulForm = "mixed: contains both precomposed syllables and decomposed jamo";
    }
    if (compatJamoCount > 0) {
      hangulForm += ` (plus ${compatJamoCount} standalone compatibility jamo, which never compose into syllables)`;
    }

    const nfc = text.normalize("NFC");
    const nfd = text.normalize("NFD");
    const nfkc = text.normalize("NFKC");
    const nfkd = text.normalize("NFKD");
    const matchesNfc = text === nfc;
    const matchesNfd = text === nfd;

    let detectedForm: string;
    if (matchesNfc && matchesNfd) {
      detectedForm = "already normalized (no composable/decomposable characters — NFC and NFD are identical here)";
    } else if (matchesNfc) {
      detectedForm = "NFC (composed)";
    } else if (matchesNfd) {
      detectedForm = "NFD (decomposed)";
    } else {
      detectedForm = "neither pure NFC nor pure NFD (mixed / partially composed)";
    }

    const shown = codePoints.slice(0, MAX_CHARACTERS_SHOWN);
    const characters = shown.map((ch) => {
      const cp = ch.codePointAt(0)!;
      const reason = invisibleReason(ch, cp);
      return {
        char: ch,
        codePoint: codePointLabel(cp),
        utf8ByteLength: Buffer.byteLength(ch, "utf8"),
        isControl: isControl(ch),
        isZeroWidth: Boolean(ZERO_WIDTH_NAMES[cp] || isVariationSelector(cp)),
        isInvisible: reason !== undefined,
        invisibleReason: reason,
      };
    });

    return {
      input: {
        totalCodePoints: codePoints.length,
        utf16Length: text.length,
        utf8ByteLength: Buffer.byteLength(text, "utf8"),
      },
      invisibleCharacters: {
        count: invisibleCount,
        present: invisibleCount > 0,
        note:
          invisibleCount > 0
            ? "One or more invisible/control/zero-width characters were found — this is a common reason two strings that look identical don't compare or search as equal."
            : "None found.",
      },
      normalization: {
        nfc: { value: nfc, differsFromInput: nfc !== text },
        nfd: { value: nfd, differsFromInput: nfd !== text },
        nfkc: { value: nfkc, differsFromInput: nfkc !== text },
        nfkd: { value: nfkd, differsFromInput: nfkd !== text },
        detectedForm,
      },
      hangul: {
        precomposedSyllableCount: syllableCount,
        decomposedJamoCount: jamoCount,
        compatibilityJamoCount: compatJamoCount,
        detectedForm: hangulForm,
      },
      characters,
      truncated: codePoints.length > MAX_CHARACTERS_SHOWN,
      charactersShown: characters.length,
    };
  },
};
