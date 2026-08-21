import type { Request } from 'express';

// Source-IP trust policy for the dashboard session gate.
//
// The dashboard is a single-user tool, so by default we trust any caller whose
// source IP is on the local machine or on the local network. Remote callers
// still need a session token (i.e. they have to log in).
//
// "Local" is defined as:
//   - 127.0.0.0/8           IPv4 loopback
//   - ::1                   IPv6 loopback
//   - 10.0.0.0/8            RFC1918 private
//   - 172.16.0.0/12         RFC1918 private
//   - 192.168.0.0/16        RFC1918 private
//   - 169.254.0.0/16        IPv4 link-local
//   - fc00::/7              IPv6 unique local (ULA)
//   - fe80::/10             IPv6 link-local
//
// This is a usability feature, not a security boundary. Anyone who can already
// send packets from your LAN has the same access as you do, so if the box is
// exposed on an untrusted LAN (guest WiFi, shared datacenter) treat the
// dashboard as effectively public. The intended deploy is the dev machine or
// a trusted home network.
//
// Trusted-by-default source IP detection is paired with a separate
// `TRUST_PROXY=1` env var that lets Express trust `X-Forwarded-For` from the
// upstream reverse proxy — without it, `req.ip` always reflects the TCP
// peer, which is the only safe posture when there's no proxy in front.

interface Ipv4Cidr { bytes: [number, number, number, number]; prefix: number }

const IPV4_CIDRS: ReadonlyArray<Ipv4Cidr> = [
  { bytes: [127, 0, 0, 0], prefix: 8 },         // 127.0.0.0/8
  { bytes: [10, 0, 0, 0], prefix: 8 },          // 10.0.0.0/8
  { bytes: [172, 16, 0, 0], prefix: 12 },       // 172.16.0.0/12
  { bytes: [192, 168, 0, 0], prefix: 16 },      // 192.168.0.0/16
  { bytes: [169, 254, 0, 0], prefix: 16 },      // 169.254.0.0/16
];

function matchIpv4Cidr(addr: [number, number, number, number], cidr: Ipv4Cidr): boolean {
  let bitsLeft = cidr.prefix;
  for (let i = 0; i < 4; i++) {
    if (bitsLeft <= 0) break;
    if (bitsLeft >= 8) {
      if (addr[i] !== cidr.bytes[i]) return false;
      bitsLeft -= 8;
    } else {
      const mask = (0xff << (8 - bitsLeft)) & 0xff;
      if ((addr[i] & mask) !== (cidr.bytes[i] & mask)) return false;
      bitsLeft = 0;
    }
  }
  return true;
}

function ipv4Trusted(addr: [number, number, number, number]): boolean {
  for (const cidr of IPV4_CIDRS) {
    if (matchIpv4Cidr(addr, cidr)) return true;
  }
  return false;
}

function parseIpv4(s: string): [number, number, number, number] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return null;
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  // Reject leading zeros ("01.2.3.4") — Node's net.isIPv4 does the same and
  // it's the only way to disambiguate octal from decimal.
  for (const p of parts) {
    if (p.length > 1 && p[0] === '0') return null;
  }
  return out as [number, number, number, number];
}

type Hextets = [number, number, number, number, number, number, number, number];

function parseHextet(s: string): number | null {
  if (s.length === 0 || s.length > 4) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n;
}

/** Parse a pure-IPv6 string (no embedded IPv4) into 8 hextets, or null. */
function parseIpv6(s: string): Hextets | null {
  if (s.length === 0) return null;
  // Strip a "%zone" suffix; we don't inspect the zone, but the rest of the
  // string is the actual address.
  const zoneIdx = s.indexOf('%');
  if (zoneIdx >= 0) s = s.slice(0, zoneIdx);
  if (s.length === 0) return null;

  const doubleColonIdx = s.indexOf('::');
  if (doubleColonIdx >= 0) {
    if (s.indexOf('::', doubleColonIdx + 1) >= 0) return null; // >1 "::"
    const left = s.slice(0, doubleColonIdx);
    const right = s.slice(doubleColonIdx + 2);
    const head = left.length === 0 ? [] : left.split(':');
    const tail = right.length === 0 ? [] : right.split(':');
    if (head.length + tail.length > 8) return null;
    const hextets: number[] = [];
    for (const h of head) {
      const n = parseHextet(h);
      if (n === null) return null;
      hextets.push(n);
    }
    const zerosNeeded = 8 - head.length - tail.length;
    for (let i = 0; i < zerosNeeded; i++) hextets.push(0);
    for (const h of tail) {
      const n = parseHextet(h);
      if (n === null) return null;
      hextets.push(n);
    }
    if (hextets.length !== 8) return null;
    return hextets as Hextets;
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = parseHextet(p);
    if (n === null) return null;
    out.push(n);
  }
  return out as Hextets;
}

/** Test that the top `prefix` bits of `addr` match the top `prefix` bits of
 * `expected`. Two shapes cover every trusted range: prefixes ≤ 16 compare
 * within the top hextet (fc00::/7, fe80::/10 — RFC 4291 leaves the bottom
 * bits free), and prefix 128 is an exact match (::1, ::). Every callsite's
 * `expected` fits in the low hextet. Any other prefix fails closed — the
 * removed BigInt path existed for multi-hextet `expected` values that no
 * trusted range ever needed. */
function ipv6MatchesPrefix(addr: Hextets, prefix: number, expected: number): boolean {
  if (prefix === 0) return true; // every address matches a /0.
  if (prefix === 128) {
    for (let i = 0; i < 7; i++) {
      if (addr[i] !== 0) return false;
    }
    return addr[7] === expected;
  }
  if (prefix < 0 || prefix > 16) return false;
  const mask = prefix === 16 ? 0xffff : (0xffff << (16 - prefix)) & 0xffff;
  return (addr[0]! & mask) === (expected & mask);
}

/** Test an IPv6 against the trusted IPv6 ranges. */
function ipv6Trusted(addr: Hextets): boolean {
  // ::1 loopback
  if (ipv6MatchesPrefix(addr, 128, 1)) return true;
  // :: unspecified — not a real client, do not auto-trust.
  if (ipv6MatchesPrefix(addr, 128, 0)) return false;
  // fc00::/7 — top 7 bits are 1111110. The pattern in the top hextet is 0xfc00.
  if (ipv6MatchesPrefix(addr, 7, 0xfc00)) return true;
  // fe80::/10 — top 10 bits are 1111111010. Pattern in the top hextet is 0xfe80.
  if (ipv6MatchesPrefix(addr, 10, 0xfe80)) return true;
  return false;
}

/**
 * Normalize an address that may be in the form "::ffff:1.2.3.4" (IPv4-mapped
 * IPv6) into a tuple of hextets. Returns null if unparseable.
 */
function ipv6FromPossiblyMapped(s: string): Hextets | null {
  if (!s.includes('.')) return parseIpv6(s);
  const dot = s.indexOf('.');
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0 || dot < lastColon) return null;
  const ipv4Str = s.slice(lastColon + 1);
  const ipv4 = parseIpv4(ipv4Str);
  if (!ipv4) return null;
  // The part before the embedded IPv4 is either compressed ("::ffff") or
  // six explicit hextets ("0:0:0:0:0:ffff" — the RFC 4291 §2.5.5.2 mapped
  // prefix written out in full).
  const hex = s.slice(0, lastColon);
  let head: Hextets | null;
  if (hex.includes('::')) {
    // Drop the trailing ':' so parseIpv6 sees "::ffff" (no empty tail hextet).
    head = parseIpv6(hex || '::');
  } else {
    const parts = hex.split(':');
    if (parts.length !== 6) return null;
    const out: number[] = [];
    for (const p of parts) {
      const n = parseHextet(p);
      if (n === null) return null;
      out.push(n);
    }
    // The six written groups are hextets 0-5; the embedded IPv4 overwrites
    // hextets 6-7 below.
    out.push(0, 0);
    head = out as Hextets;
  }
  if (!head) return null;
  // Sanity: the top 80 bits must be zero for this to be an IPv4-mapped /
  // -compatible address (hextet 5 is 0xffff in the mapped form, 0 in the
  // compatible form). Checking only [0..4] keeps the compressed
  // "::ffff:a.b.c.d" spelling and the uncompressed
  // "0:0:0:0:0:ffff:a.b.c.d" spelling on exactly the same footing.
  if (!(head[0] === 0 && head[1] === 0 && head[2] === 0 && head[3] === 0
        && head[4] === 0)) {
    return null;
  }
  head[6] = (ipv4[0] << 8) | ipv4[1];
  head[7] = (ipv4[2] << 8) | ipv4[3];
  return head;
}

/** Returns true if the address belongs to a range we auto-trust. */
export function isTrustedSourceIp(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const trimmed = addr.trim();
  if (trimmed.length === 0) return false;

  // Strip a "[…]:port" suffix for IPv6 literals.
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end >= 0) {
      const inner = trimmed.slice(1, end);
      if (isTrustedSourceIp(inner)) return true;
    }
    return false;
  }

  // Distinguish "10.0.0.1:51234" (IPv4 with port — no embedded colon in the
  // host portion) from "::1" or "::ffff:1.2.3.4" (IPv6 with colons).
  if (trimmed.includes(':') && !trimmed.includes('.')) {
    const v6 = parseIpv6(trimmed);
    return v6 ? ipv6Trusted(v6) : false;
  }
  if (trimmed.includes(':') && trimmed.includes('.')) {
    // Could be either "10.0.0.1:51234" (host:port) or "::ffff:1.2.3.4" (mapped).
    // If the substring before the last colon parses as IPv4, treat as host:port.
    const lastColon = trimmed.lastIndexOf(':');
    const host = trimmed.slice(0, lastColon);
    const v4 = parseIpv4(host);
    if (v4) return ipv4Trusted(v4);
    // Otherwise assume it's the IPv4-mapped form.
    const v6 = ipv6FromPossiblyMapped(trimmed);
    if (!v6) return false;
    return ipv4Trusted([
      (v6[6] >> 8) & 0xff,
      v6[6] & 0xff,
      (v6[7] >> 8) & 0xff,
      v6[7] & 0xff,
    ]);
  }

  // No colons, no brackets: pure IPv4.
  const v4 = parseIpv4(trimmed);
  if (v4) return ipv4Trusted(v4);
  return false;
}

/**
 * Resolve the effective client IP. `X-Forwarded-For` is honored ONLY when
 * the direct TCP peer is itself a trusted proxy (H09):
 *
 *  - `TRUST_PROXY=1` / `true` — single-hop trust: the peer must be loopback
 *    (the canonical local reverse proxy). A remote client that connects
 *    directly while forging `X-Forwarded-For: 127.0.0.1` is NOT trusted.
 *  - `TRUST_PROXY=<cidr>[,<cidr>…]` — the peer must match one of the listed
 *    proxy CIDRs; XFF entries are then walked right-to-left across trusted
 *    proxies and the first untrusted address is the client.
 *
 * Without TRUST_PROXY, the socket peer address is always used verbatim.
 */
export function getClientIp(req: Pick<Request, 'headers' | 'socket'>): string | null {
  const sock = req.socket as { remoteAddress?: string | null } | undefined;
  const peer = normalizeIpString(sock?.remoteAddress);
  if (!trustProxyConfigured()) return peer;
  if (peer === null || !isTrustedProxyPeer(peer)) return peer; // no/foreign proxy: ignore XFF entirely

  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length === 0) return peer;
  for (let i = xff.length - 1; i >= 0; i--) {
    const entry = normalizeIpString(xff[i]);
    if (entry === null || !isTrustedProxyPeer(entry)) return entry; // first untrusted from the right = client
  }
  return peer; // every hop was a trusted proxy — the peer itself is the client
}

// ── Trusted-proxy configuration (H09) ──────────────────────────────────────
// NOTE: read at call time, never snapshotted at module load — tests and the
// PM2 wrapper set TRUST_PROXY after imports resolve.

function trustProxyConfigured(): boolean {
  const raw = process.env.TRUST_PROXY ?? '';
  return raw.length > 0 && raw !== '0' && raw !== 'false';
}

function normalizeIpString(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  return ip.length > 0 ? ip : null;
}

/** True when `ip` is a proxy we are willing to believe about XFF contents. */
function isTrustedProxyPeer(ip: string): boolean {
  const raw = process.env.TRUST_PROXY ?? '';
  if (raw === '1' || raw === 'true') {
    // Single-hop mode: only a loopback peer (local reverse proxy) is trusted.
    return ip === '::1' || /^127\./.test(ip);
  }
  // CIDR-list mode: match any listed subnet.
  for (const cidr of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (ipInCidr(ip, cidr)) return true;
  }
  return false;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [baseRaw, prefixRaw] = cidr.split('/');
  const prefix = prefixRaw !== undefined ? Number(prefixRaw) : 32;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const base = parseIpv4(baseRaw ?? '');
  const addr = parseIpv4(ip);
  if (!base || !addr) return false;
  let bits = prefix;
  for (let i = 0; i < 4; i++) {
    if (bits <= 0) break;
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((addr[i] & mask) !== (base[i] & mask)) return false;
    bits -= 8;
  }
  return true;
}

/**
 * True when the request comes from a source we treat as already
 * authenticated (loopback, RFC1918, IPv6 ULA / link-local). Routes that
 * expose auth state — like `/api/auth/status` — call this so they report
 * `authenticated: true` for the LAN case; the gate middleware uses the same
 * check to skip session validation for those callers.
 */
export function isTrustedRequest(req: Pick<Request, 'headers' | 'socket'>): boolean {
  return isTrustedSourceIp(getClientIp(req));
}