import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';
import { isTrustedRequest } from '../lib/ip-trust.js';
import { readSessionCookie } from '../lib/session-cookie.js';

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>`, an `x-dashboard-token` header, or the
// HttpOnly session cookie set by those same routes (Improvement 1 — the cookie
// keeps the token out of XSS-readable storage and lets EventSource
// authenticate). The /v1 proxy is NOT gated by this — it keeps its own
// unified-API-key auth for app clients.
//
// Single-user convenience: a caller whose source IP is on the local machine or
// the local network (loopback, RFC1918, link-local, IPv6 ULA / link-local) is
// treated as already authenticated. The dashboard is intended for one operator
// on a trusted network, so the login form is suppressed for those callers.
// Remote callers still need a valid session token. See server/src/lib/ip-trust.ts
// for the full policy and its limitations.
// L24: strict truthiness ('1'/'true' only, matching the TRUST_PROXY check in
// app.ts) — '0'/'false'/garbage must NOT silently enable the gate. Shared so
// routes/auth.ts /status reports LAN-trust with identical semantics.
/** N20: only a Bearer credential may be read from the Authorization header.
 *  Other schemes (Basic, Digest, …) previously leaked through the replace()
 *  no-op and were validated as raw session ids. A non-Bearer header yields
 *  undefined so the x-dashboard-token / session-cookie fallbacks still apply;
 *  the helper intentionally does NOT consume those — callers chain them. */
function extractBearerOrFallback(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) {
    return (req.headers['x-dashboard-token'] as string | undefined);
  }
  return header.replace(/^Bearer\s+/i, '').trim() || undefined;
}

export function dashboardRequireLoginEnabled(): boolean {
  return process.env.DASHBOARD_REQUIRE_LOGIN === '1'
    || process.env.DASHBOARD_REQUIRE_LOGIN === 'true';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // DASHBOARD_REQUIRE_LOGIN=1 opts out of LAN auto-trust — on a shared or
  // untrusted LAN, auto-trust grants full /api/* (including key exfiltration
  // endpoints) to any loopback/RFC1918 source with no session.
  // L24: strict truthiness ('1'/'true' only, matching the TRUST_PROXY check
  // in app.ts) — '0'/'false'/garbage must NOT silently enable the gate.
  if (!dashboardRequireLoginEnabled() && isTrustedRequest(req)) {
    next();
    return;
  }
  const token = extractBearerOrFallback(req)
    ?? readSessionCookie(req);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  (req as Request & { user?: typeof session }).user = session;
  next();
}

/** Like requireAuth but never auto-trusts LAN — always requires a valid session.
 *  Use on sensitive endpoints (config export, unified API key) so a trusted-LAN
 *  caller still needs a login session (Imp 18). */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerOrFallback(req)
    ?? readSessionCookie(req);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  (req as Request & { user?: typeof session }).user = session;
  next();
}
