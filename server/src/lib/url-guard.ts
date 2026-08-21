import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF-hardened outbound URL validation (H10). The literal host-string
 * matchers used previously miss `::ffff:127.0.0.1`, hex/octal/decimal IPv4
 * forms (`0x7f.1.1.1`, `2130706433`), and any public hostname that RESOLVES
 * to a private address (cloud metadata endpoints via DNS). This guard
 * resolves the hostname and validates every resulting address, and callers
 * re-invoke it on EVERY redirect hop (fetch with `redirect: 'manual'`).
 */
export class UrlGuardError extends Error {
  constructor(url: string, reason: string) {
    super(`Blocked URL ${url}: ${reason}`);
    this.name = 'UrlGuardError';
  }
}

const PRIVATE_V4_RANGES: Array<{ base: [number, number, number, number]; prefix: number }> = [
  { base: [0, 0, 0, 0], prefix: 8 },         // "this network" / unspecified
  { base: [10, 0, 0, 0], prefix: 8 },        // RFC1918
  { base: [100, 64, 0, 0], prefix: 10 },     // CGNAT
  { base: [127, 0, 0, 0], prefix: 8 },       // loopback (ALL of 127/8, incl. 127.0.0.2+)
  { base: [169, 254, 0, 0], prefix: 16 },    // link-local + cloud metadata
  { base: [172, 16, 0, 0], prefix: 12 },     // RFC1918
  { base: [192, 0, 0, 0], prefix: 24 },      // IETF protocol assignments
  { base: [192, 0, 2, 0], prefix: 24 },      // TEST-NET-1
  { base: [192, 88, 99, 0], prefix: 24 },    // 6to4 relay (deprecated)
  { base: [192, 168, 0, 0], prefix: 16 },    // RFC1918
  { base: [198, 18, 0, 0], prefix: 15 },     // benchmarking
  { base: [198, 51, 100, 0], prefix: 24 },   // TEST-NET-2
  { base: [203, 0, 113, 0], prefix: 24 },    // TEST-NET-3
  { base: [224, 0, 0, 0], prefix: 4 },       // multicast
  { base: [240, 0, 0, 0], prefix: 4 },       // reserved / broadcast
];

export function isPrivateV4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const o = ip.split('.').map(Number);
  for (const { base, prefix } of PRIVATE_V4_RANGES) {
    let bits = prefix;
    let match = true;
    for (let i = 0; i < 4 && bits > 0; i++) {
      const mask = bits >= 8 ? 255 : (255 << (8 - bits)) & 255;
      if ((o[i] & mask) !== (base[i] & mask)) { match = false; break; }
      bits -= 8;
    }
    if (match) return true;
  }
  return false;
}

export function isPrivateV6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified / loopback
  // IPv4-mapped, dotted form: ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  // IPv4-mapped, HEX form: ::ffff:7f00:1 — URL canonicalization rewrites
  // the dotted form to this, so both spellings must be checked.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >>> 8}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`);
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/** Validate an outbound http(s) URL: scheme check + local-name check + DNS
 *  resolution with every address checked against private ranges. Throws
 *  UrlGuardError on any violation. Returns the parsed URL for convenience. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError(raw, 'malformed URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError(raw, `scheme ${url.protocol} not allowed`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new UrlGuardError(raw, 'empty host');

  if (net.isIPv4(host)) {
    if (isPrivateV4(host)) throw new UrlGuardError(raw, `private IPv4 ${host}`);
    return url;
  }
  if (net.isIPv6(host)) {
    if (isPrivateV6(host)) throw new UrlGuardError(raw, `private IPv6 ${host}`);
    return url;
  }
  // Hostname form — local names never leave the machine.
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) {
    throw new UrlGuardError(raw, `local hostname ${host}`);
  }
  // Resolve and check EVERY address. getaddrinfo also normalizes hex/octal/
  // decimal IP spellings (e.g. `0x7f.1.1.1` → 127.0.0.1), which literal
  // string matchers miss.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(h, { all: true, verbatim: true });
  } catch {
    throw new UrlGuardError(raw, `DNS resolution failed for ${host}`);
  }
  if (addrs.length === 0) throw new UrlGuardError(raw, `no addresses for ${host}`);
  for (const { address, family } of addrs) {
    const bad = family === 4 ? isPrivateV4(address) : isPrivateV6(address);
    if (bad) throw new UrlGuardError(raw, `resolves to private address ${address}`);
  }
  return url;
}
