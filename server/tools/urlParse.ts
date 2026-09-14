import net from "node:net";
import type { ToolDefinition } from "./types.js";

// ---- Punycode decoding (RFC 3492), implemented locally --------------------
//
// Node's WHATWG `URL` class converts a Unicode host to its ASCII/punycode
// form automatically (IDNA ToASCII), but there is no built-in ToUnicode to
// go the other way, and Node's old `punycode` core module is deprecated (and
// slated for removal) — the house rule for this codebase is no external
// dependencies, so a userland punycode package isn't an option either. RFC
// 3492's decode algorithm is short and completely self-contained, so it's
// reimplemented here for the one thing this tool needs: turning an
// "xn--..." label back into the Unicode text it stands for.

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

function punycodeAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

function punycodeDecodeDigit(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30 + 26; // '0'-'9' -> 26-35
  if (codePoint >= 0x41 && codePoint <= 0x5a) return codePoint - 0x41; // 'A'-'Z' -> 0-25
  if (codePoint >= 0x61 && codePoint <= 0x7a) return codePoint - 0x61; // 'a'-'z' -> 0-25
  throw new Error("invalid punycode digit");
}

/** Decodes the part of an "xn--" label after the "xn--" prefix. Throws on malformed input. */
function punycodeDecode(input: string): string {
  let n = PUNY_INITIAL_N;
  let i = 0;
  let bias = PUNY_INITIAL_BIAS;
  const output: number[] = [];

  const lastDelimiter = input.lastIndexOf("-");
  let rest: string;
  if (lastDelimiter >= 0) {
    for (let j = 0; j < lastDelimiter; j++) {
      const cp = input.codePointAt(j)!;
      if (cp >= 0x80) throw new Error("invalid punycode: non-ASCII character before the last \"-\"");
      output.push(cp);
    }
    rest = input.slice(lastDelimiter + 1);
  } else {
    rest = input;
  }

  let pos = 0;
  while (pos < rest.length) {
    const previousI = i;
    let weight = 1;
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (pos >= rest.length) throw new Error("invalid punycode: unexpected end of input");
      const digit = punycodeDecodeDigit(rest.codePointAt(pos)!);
      pos++;
      i += digit * weight;
      const threshold = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < threshold) break;
      weight *= PUNY_BASE - threshold;
    }
    bias = punycodeAdapt(i - previousI, output.length + 1, previousI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

function toUnicodeHost(hostname: string): { isIdn: boolean; unicodeHost: string | null } {
  let changed = false;
  const decodedLabels = hostname.split(".").map((label) => {
    const match = /^xn--(.+)$/i.exec(label);
    if (!match) return label;
    try {
      const decoded = punycodeDecode(match[1]!);
      changed = true;
      return decoded;
    } catch (err) {
      throw new Error(`Host label "${label}" looks like punycode but failed to decode: ${(err as Error).message}`);
    }
  });
  return { isIdn: changed, unicodeHost: changed ? decodedLabels.join(".") : null };
}

// ---- Host classification ---------------------------------------------------

function hostType(hostname: string): "ipv4" | "ipv6" | "domain" {
  if (net.isIPv4(hostname)) return "ipv4";
  const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIPv6(stripped)) return "ipv6";
  return "domain";
}

const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "ftp:": 21,
  "ftps:": 990,
  "ws:": 80,
  "wss:": 443,
  "ssh:": 22,
  "sftp:": 22,
};

// The URL parser has already turned any "%" that isn't part of a valid
// escape into a literal "%25", so decodeURIComponent should never throw here
// in practice — the try/catch is defensive, not load-bearing.
function decodePart(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function decodeOrNull(text: string): string | null {
  return text.length === 0 ? null : decodePart(text);
}

export const urlParseTool: ToolDefinition = {
  name: "url_parse",
  description:
    "Break a URL into its parts: scheme, host (noting an IP literal, and decoding a punycode host to Unicode), port including the scheme default, path and its segments, query parameters percent-decoded as name/value pairs preserving repeats, and the fragment. Reports whether a password is present without echoing it.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: 'Absolute URL to parse, e.g. "https://user:pass@xn--fsq.example.com:8443/a/b?x=1&x=2#frag".',
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(args: { url: string }) {
    if (typeof args?.url !== "string" || args.url.length === 0) {
      throw new Error("url must be a non-empty string");
    }

    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch (err) {
      throw new Error(
        `"${args.url}" is not a valid absolute URL (it must include a scheme, e.g. "https://"): ${(err as Error).message}`,
      );
    }

    const scheme = parsed.protocol.replace(/:$/, "");
    const host = parsed.hostname;
    const type = hostType(host);
    const { isIdn, unicodeHost } = type === "domain" ? toUnicodeHost(host) : { isIdn: false, unicodeHost: null };

    const explicitPort = parsed.port !== "";
    const port = explicitPort ? Number(parsed.port) : (DEFAULT_PORTS[parsed.protocol] ?? null);

    const pathSegments = parsed.pathname.split("/").filter((s) => s.length > 0).map(decodePart);
    const queryParams = [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));

    // `URL#href` embeds the raw password verbatim ("user:pass@host") when one
    // is present, so it has to be redacted before being echoed back — never
    // trust a derived/convenience field to have scrubbed a secret on its own.
    let href = parsed.href;
    if (parsed.password) {
      const redacted = new URL(parsed.href);
      redacted.password = "REDACTED";
      href = redacted.href;
    }

    return {
      href,
      scheme,
      username: decodeOrNull(parsed.username),
      hasPassword: parsed.password.length > 0,
      host,
      hostType: type,
      isIdn,
      unicodeHost,
      port,
      portIsDefault: !explicitPort,
      path: parsed.pathname,
      pathSegments,
      queryParams,
      fragment: decodeOrNull(parsed.hash.slice(1)),
    };
  },
};
