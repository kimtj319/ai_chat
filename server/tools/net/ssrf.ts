import dns from "node:dns/promises";
import net from "node:net";

// Addresses that must never be reachable from the http_fetch tool.
//
// A BlockList rather than hand-written range checks: it matches an IPv4-mapped
// IPv6 address (::ffff:7f00:1, which is how the URL parser rewrites
// [::ffff:127.0.0.1]) against the IPv4 subnets below. The hand-written version
// only unwrapped the dotted spelling and let the hex one through to loopback.
const BLOCKED = new net.BlockList();
for (const [base, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  BLOCKED.addSubnet(base, bits, "ipv4");
}
for (const [base, bits] of [
  ["::", 96], // unspecified, loopback and the deprecated IPv4-compatible form (::7f00:1)
  ["64:ff9b::", 96], // NAT64: the low 32 bits are an IPv4 address the gateway would reach for us
  ["fe80::", 10], // link-local
  ["fc00::", 7], // unique local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(base, bits, "ipv6");
}

export function isPublicIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) return false; // not a recognisable IP — treat as blocked
  return !BLOCKED.check(ip, version === 4 ? "ipv4" : "ipv6");
}

export async function resolveAllAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * Throws if `hostname` cannot be resolved, or resolves to any loopback/link-local/private address.
 *
 * KNOWN GAP (DNS rebinding): this resolves the name, and the fetch that follows
 * resolves it again. A name with a zero TTL can answer a public address here and
 * a private one to the fetch. Closing it means pinning the checked address into
 * the connection (an undici Agent `connect.lookup`, or node:http with a `lookup`
 * hook), which is a dependency or a rewrite of the fetch path — not done yet.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
  assertPublicAddresses(hostname, await resolveAllAddresses(hostname));
}

/** The check itself, for a caller that has already resolved `hostname` for a check of its own. */
export function assertPublicAddresses(hostname: string, addresses: string[]): void {
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);
  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new Error(`Blocked: "${hostname}" resolves to a non-public address (${addr})`);
    }
  }
}
