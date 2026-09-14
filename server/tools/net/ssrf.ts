import dns from "node:dns/promises";
import net from "node:net";

// IPv4 ranges that must never be reachable from the http_fetch tool.
const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isV4InRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

export function isPublicIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return !PRIVATE_V4_RANGES.some(([base, bits]) => isV4InRange(ip, base, bits));
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return false; // loopback / unspecified
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return false; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false; // unique local fc00::/7
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      if (net.isIP(v4) === 4) return isPublicIp(v4);
    }
    return true;
  }
  return false; // not a recognisable IP — treat as blocked
}

export async function resolveAllAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** Throws if `hostname` cannot be resolved, or resolves to any loopback/link-local/private address. */
export async function assertPublicHostname(hostname: string): Promise<void> {
  const addresses = await resolveAllAddresses(hostname);
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);
  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new Error(`Blocked: "${hostname}" resolves to a non-public address (${addr})`);
    }
  }
}
