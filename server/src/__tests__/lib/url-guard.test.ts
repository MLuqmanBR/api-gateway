// H09/H10 regressions: X-Forwarded-For trust requires a trusted proxy peer,
// and the outbound URL guard resolves hosts and rejects every private form.
import { getClientIp, isTrustedRequest } from '../../lib/ip-trust.js';
import { assertPublicHttpUrl, UrlGuardError, isPrivateV4, isPrivateV6 } from '../../lib/url-guard.js';

function fakeReq(opts: { ip?: string; remoteAddress?: string | null; xff?: string }) {
  return {
    ip: opts.ip,
    socket: { remoteAddress: opts.remoteAddress },
    headers: opts.xff !== undefined ? { 'x-forwarded-for': opts.xff } : {},
  } as any;
}

describe('H09 — XFF spoofing requires a trusted proxy peer', () => {
  it('direct client forging XFF: 127.0.0.1 is NOT trusted (no proxy peer)', () => {
    // TRUST_PROXY unset in this process → socket peer always used.
    const ip = getClientIp(fakeReq({ remoteAddress: '203.0.113.9', xff: '127.0.0.1' }));
    expect(ip).toBe('203.0.113.9');
    expect(isTrustedRequest(fakeReq({ remoteAddress: '203.0.113.9', xff: '127.0.0.1' }))).toBe(false);
  });

  it('loopback peer remains trusted', () => {
    expect(isTrustedRequest(fakeReq({ remoteAddress: '127.0.0.1' }))).toBe(true);
    expect(isTrustedRequest(fakeReq({ remoteAddress: '::ffff:127.0.0.1' }))).toBe(true);
  });

  it('LAN peer remains trusted by the documented LAN policy', () => {
    expect(isTrustedRequest(fakeReq({ remoteAddress: '192.168.1.23' }))).toBe(true);
  });
});

describe('H10 — resolving SSRF URL guard', () => {
  it('rejects literal private IPv4 forms', async () => {
    for (const u of [
      'http://127.0.0.1/x', 'http://127.0.0.2/x', 'http://10.1.2.3/x',
      'http://192.168.0.1/x', 'http://172.16.5.5/x', 'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/x', 'http://100.64.0.1/x',
    ]) {
      await expect(assertPublicHttpUrl(u)).rejects.toBeInstanceOf(UrlGuardError);
    }
  });

  it('rejects IPv6 loopback / mapped / ULA / link-local literals', async () => {
    for (const u of [
      'http://[::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://[fc00::1]/x', 'http://[fd12::1]/x', 'http://[fe80::1]/x',
    ]) {
      await expect(assertPublicHttpUrl(u)).rejects.toBeInstanceOf(UrlGuardError);
    }
  });

  it('rejects non-http schemes, malformed URLs and local names', async () => {
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'not a url', 'http://localhost/x', 'http://printer.local/x']) {
      await expect(assertPublicHttpUrl(u)).rejects.toBeInstanceOf(UrlGuardError);
    }
  });

  it('a public hostname that RESOLVES to loopback is rejected (DNS-to-private)', async () => {
    // localtest.me is public DNS that resolves to 127.0.0.1. If resolution is
    // unavailable offline, the guard still rejects (no addresses resolvable)
    // — either way this must throw, never pass.
    await expect(assertPublicHttpUrl('http://localtest.me:46124/webhook-recv')).rejects.toBeInstanceOf(UrlGuardError);
  });

  it('accepts a genuinely public URL', async () => {
    const u = await assertPublicHttpUrl('https://example.com/path?q=1');
    expect(u.hostname).toBe('example.com');
  });

  it('private-range classifiers are correct', () => {
    expect(isPrivateV4('127.0.0.2')).toBe(true);
    expect(isPrivateV4('1.1.1.1')).toBe(false);
    expect(isPrivateV6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateV6('::ffff:7f00:1')).toBe(true); // hex-mapped 127.0.0.1 (URL-canonicalized form)
    expect(isPrivateV6('2607:f8b0::1')).toBe(false);
  });
});
