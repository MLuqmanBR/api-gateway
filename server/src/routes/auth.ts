import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  userCount,
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
  deleteSession,
} from '../services/auth.js';
import { isTrustedRequest } from '../lib/ip-trust.js';
import { setSessionCookie, clearSessionCookie, readSessionCookie } from '../lib/session-cookie.js';

export const authRouter = Router();

// Dashboard auth (#35). These routes are mounted BEFORE requireAuth, so
// /status, /setup and /login are reachable without a session (bootstrap);
// /logout and /me validate the token themselves.

const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// ── Brute-force throttle ──────────────────────────────────────────────────
// Simple in-memory per-email limiter. A local single-user tool doesn't need a
// distributed store; this just blunts online password guessing.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(email: string): boolean {
  const a = attempts.get(email.toLowerCase());
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const key = email.toLowerCase();
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
  // Guard against unbounded growth — a remote attacker can POST unlimited
  // random emails.  Evict stale entries past ~10k and, if still over cap,
  // drop the oldest insertion.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) {
      if (v.lockedUntil < Date.now() && v.count === 0) attempts.delete(k);
    }
    if (attempts.size > 10_000) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of attempts) {
        if (v.lockedUntil < oldestTime) { oldestTime = v.lockedUntil; oldestKey = k; }
      }
      attempts.delete(oldestKey);
    }
  }
}
function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}

// Session token from the request: bearer header, x-dashboard-token header, or
// the HttpOnly session cookie (Improvement 1) — same precedence as requireAuth.
function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined)
    ?? readSessionCookie(req);
}

// Has the dashboard been set up yet, and is this caller authenticated?
// LAN/loopback callers are treated as authenticated even without a session
// token, mirroring the requireAuth gate; remote callers must hold a valid
// session. The `email` field stays null for the LAN case — there is no
// user identity, just network-trust — which keeps the client free to omit
// any "signed in as X" UI.
authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  res.json({
    needsSetup: userCount() === 0,
    authenticated: !!session || isTrustedRequest(req),
    email: session?.email ?? null,
  });
});

// First-run account creation. Only allowed while there are zero users, so it
// can't be used to add accounts once the dashboard is claimed.
authRouter.post('/setup', (req: Request, res: Response) => {
  if (userCount() > 0) {
    res.status(409).json({ error: { message: 'Setup already completed. Use login instead.', type: 'setup_complete' } });
    return;
  }
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password);
  const token = createSession(user.userId);
  // HttpOnly session cookie alongside the JSON token (Improvement 1). The
  // token stays in the body for backward compatibility with bearer clients.
  setSessionCookie(req, res, token);
  res.status(201).json({ token, email: user.email });
});

authRouter.post('/login', (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  if (isLockedOut(email)) {
    res.status(429).json({ error: { message: 'Too many failed attempts. Try again later.', type: 'rate_limit_error' } });
    return;
  }

  const user = verifyCredentials(email, password);
  if (!user) {
    recordFailure(email);
    // Same message whether the email exists or not — don't leak which.
    res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
    return;
  }

  clearFailures(email);
  const token = createSession(user.userId);
  // HttpOnly session cookie alongside the JSON token (Improvement 1). The
  // token stays in the body for backward compatibility with bearer clients.
  setSessionCookie(req, res, token);
  res.json({ token, email: user.email });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  deleteSession(bearer(req));
  clearSessionCookie(res);
  res.json({ success: true });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({ email: session.email });
});
