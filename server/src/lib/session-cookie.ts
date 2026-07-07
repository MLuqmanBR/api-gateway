import type { Request, Response } from 'express';
import { SESSION_TTL_MS } from '../services/auth.js';

// HttpOnly dashboard session cookie (Improvement 1).
//
// On /api/auth/setup + /login the server sets this cookie ALONGSIDE the existing
// JSON token response (the token is still returned for backward compatibility).
// The cookie carries the same opaque session token, but being HttpOnly it is not
// readable by page JS — so an XSS can't exfiltrate it the way it can read the
// localStorage token. It also lets `EventSource` (which can't send an
// `Authorization` header) authenticate the /api/events SSE stream, because the
// browser attaches the cookie automatically.
//
// Attributes: `HttpOnly; SameSite=Lax; Path=/api` (+ `Secure` only under TLS).
//   - Path=/api scopes it to the admin surface; /v1 (unified-key auth) and the
//     static SPA never carry it.
//   - SameSite=Lax blocks cross-site POST/PATCH/DELETE CSRF outright while still
//     allowing the dashboard's own same-origin requests.
//   - Secure is conditional: this proxy usually runs plain HTTP on a LAN, and a
//     Secure cookie would be silently dropped by the browser over HTTP.
export const SESSION_COOKIE_NAME = 'api-gateway_session';

const COOKIE_PATH = '/api';

/**
 * Set the HttpOnly session cookie carrying `token`. `Secure` is applied only
 * when the request arrived over TLS (`req.secure`, which honors
 * `X-Forwarded-Proto` when `TRUST_PROXY` is set) — otherwise the cookie would
 * be dropped on the plain-HTTP LAN deployment. Max-Age matches the session TTL.
 */
export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: COOKIE_PATH,
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
  });
}

/**
 * Clear the session cookie (on logout). The path must match how it was set or
 * the browser will not remove it.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: COOKIE_PATH });
}

/**
 * Minimal parse of the session cookie from the raw `Cookie` header.
 * `cookie-parser` is deliberately NOT a dependency (nothing else needs it), so
 * we read `req.headers.cookie` and extract our named cookie by hand rather than
 * pulling in a package. Returns undefined when the cookie is absent/malformed.
 */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    // Values set via res.cookie() are URL-encoded; our token is hex so this is
    // a no-op, but decode defensively and fall back to the raw value.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return undefined;
}
