import type { ToolDefinition } from "./types.js";

// All arithmetic here treats an IPv4 address as a plain JS number in
// [0, 2^32-1] rather than doing signed 32-bit bit-twiddling by hand. Bitwise
// operators (&, |, ~) still work correctly on these values: JS converts both
// operands to a 32-bit two's-complement representation before the op and
// converts the (possibly negative) result back with `>>> 0`, so the bit
// pattern round-trips correctly even though 2^32-1 itself is not a valid
// Int32. This is the standard trick and it keeps the arithmetic readable.

const OCTET_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/; // rejects leading zeros like "01"

function parseIPv4(text: string, label: string): number {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => OCTET_RE.test(p))) {
    throw new Error(`${label} is not a valid IPv4 address: "${text}"`);
  }
  const [a, b, c, d] = parts.map(Number);
  return a! * 0x1000000 + b! * 0x10000 + c! * 0x100 + d!;
}

function intToIPv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

function prefixToMaskInt(prefix: number): number {
  if (prefix === 0) return 0; // (32 - 0) === 32, and `<< 32` in JS is a no-op shift (shift amount is taken mod 32), so 0 must be special-cased
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function classify(networkInt: number): { isPrivate: boolean; isLoopback: boolean; isLinkLocal: boolean } {
  const a = (networkInt >>> 24) & 0xff;
  const b = (networkInt >>> 16) & 0xff;
  return {
    isPrivate: a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168),
    isLoopback: a === 127,
    isLinkLocal: a === 169 && b === 254,
  };
}

export const cidrCalcTool: ToolDefinition = {
  name: "cidr_calc",
  description:
    "IPv4 subnet arithmetic for a CIDR block such as \"10.0.0.0/22\": network and broadcast address, netmask, wildcard mask, first and last usable host, total and usable address counts, and whether the block is private, loopback or link-local. /31 and /32 are reported by their real semantics. Optionally tests whether an address is inside the block.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      cidr: { type: "string", description: 'IPv4 CIDR block, e.g. "10.0.0.0/22" or "192.168.1.10/24".' },
      contains: {
        type: "string",
        description: 'Optional IPv4 address to test for membership in the block, e.g. "10.0.1.5".',
      },
    },
    required: ["cidr"],
    additionalProperties: false,
  },
  async execute(args: { cidr: string; contains?: string }) {
    if (typeof args?.cidr !== "string" || args.cidr.length === 0) {
      throw new Error("cidr must be a non-empty string, e.g. \"10.0.0.0/22\"");
    }
    const slashIndex = args.cidr.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(`cidr must include a prefix length, e.g. "10.0.0.0/22" (got "${args.cidr}")`);
    }
    const addressText = args.cidr.slice(0, slashIndex);
    const prefixText = args.cidr.slice(slashIndex + 1);
    if (!/^(3[0-2]|[12]?\d)$/.test(prefixText)) {
      throw new Error(`prefix length must be an integer from 0 to 32 (got "${prefixText}" in "${args.cidr}")`);
    }
    const prefix = Number(prefixText);
    const addressInt = parseIPv4(addressText, "cidr address");

    const netmaskInt = prefixToMaskInt(prefix);
    const networkInt = (addressInt & netmaskInt) >>> 0;
    const wildcardInt = ~netmaskInt >>> 0;
    const broadcastInt = (networkInt | wildcardInt) >>> 0;
    const totalAddresses = 2 ** (32 - prefix);

    let broadcast: string | null;
    let firstUsableHost: string | null;
    let lastUsableHost: string | null;
    let usableHostCount: number;
    let specialCase: string | null;

    if (prefix === 32) {
      broadcast = null;
      firstUsableHost = intToIPv4(networkInt);
      lastUsableHost = firstUsableHost;
      usableHostCount = 1;
      specialCase =
        "/32 is a single host route: there is no network/broadcast distinction and no address range — the one " +
        "address itself is the usable host.";
    } else if (prefix === 31) {
      broadcast = null;
      firstUsableHost = intToIPv4(networkInt);
      lastUsableHost = intToIPv4(broadcastInt);
      usableHostCount = 2;
      specialCase =
        "/31 is a point-to-point link (RFC 3021): both addresses are usable and there is no reserved network or " +
        "broadcast address.";
    } else {
      broadcast = intToIPv4(broadcastInt);
      firstUsableHost = intToIPv4(networkInt + 1);
      lastUsableHost = intToIPv4(broadcastInt - 1);
      usableHostCount = totalAddresses - 2;
      specialCase = null;
    }

    const result: Record<string, unknown> = {
      cidr: args.cidr,
      network: intToIPv4(networkInt),
      broadcast,
      netmask: intToIPv4(netmaskInt),
      wildcardMask: intToIPv4(wildcardInt),
      prefixLength: prefix,
      totalAddresses,
      firstUsableHost,
      lastUsableHost,
      usableHostCount,
      specialCase,
      addressClassification: classify(networkInt),
    };

    if (args.contains !== undefined) {
      if (typeof args.contains !== "string" || args.contains.length === 0) {
        throw new Error("contains must be a non-empty IPv4 address string when provided");
      }
      const containsInt = parseIPv4(args.contains, "contains");
      const isMember = ((containsInt & netmaskInt) >>> 0) === networkInt;
      result.contains = { ip: args.contains, isMember };
    }

    return result;
  },
};
