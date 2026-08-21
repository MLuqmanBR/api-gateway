import type { Request, Response, NextFunction } from 'express';

// Per-IP fixed-window rate limiter for the public /v1 proxy (#35, item #6).
//
// The /v1 surface authenticates with the unified API key but has no password
// login like the dashboard does, so without this an attacker who can reach the
// server could brute-force the key or flood upstream providers. This caps how
// many requests a single client IP can make per minute and returns a standard
// OpenAI-shaped 429 once the cap is exceeded.
//
// API-Gateway is a single-user tool, so the default ceiling is generous. Tune it
// with PROXY_RATE_LIMIT_RPM (requests per minute per IP); set it to 0 to turn
// rate limiting off entirely.

const WINDOW_MS = 60_000;
const DEFAULT_RPM = 120;
// Bound the IP map so a flood of distinct (e.g. spoofed) source addresses can't
// grow it without limit; expired entries are pruned opportunistically.
const MAX_TRACKED_IPS = 10_000;

interface WindowState {
  count: number;
  resetAt: number;
}

function parseLimit(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

interface WindowLimiterOptions {
  // Max requests per window. A limit <= 0 disables the limiter entirely.
  limit: number;
  windowMs: number;
  // Skip counting requests carrying `x-api-gateway-internal: 1` (trusted only
  // in the sense that the /v1 mount enables it — see createProxyRateLimiter).
  exemptInternal?: boolean;
  // Body of the 429 error message. Receives (limit, retryAfterSeconds).
  tooManyMessage: (limit: number, retryAfterSec: number) => string;
}

// L08: ONE fixed-window implementation shared by every per-IP limiter. The
// proxy limiter and the dashboard per-IP limiter used to be two drifted copies
// of the same body; they only ever differed in configuration (window length,
// internal-subrequest exemption, error wording), which is exactly what the
// options below express.
//
// Eviction guarantee: when the IP map overflows, expired entries are pruned
// first, then the OLDEST active window is evicted — but never the caller's own
// entry. Evicting the current IP would reset its counter mid-request, so the
// X-RateLimit-* headers just written would describe a window that no longer
// exists and the next request would start a fresh (unthrottled) count.
function createWindowLimiter(options: WindowLimiterOptions) {
  const windows = new Map<string, WindowState>();

  return function windowLimit(req: Request, res: Response, next: NextFunction): void {
    if (options.exemptInternal && req.headers['x-api-gateway-internal'] === '1') {
      next();
      return;
    }
    if (options.limit <= 0) {
      next();
      return;
    }

    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let state = windows.get(ip);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + options.windowMs };
      windows.set(ip, state);
    }
    state.count += 1;

    if (windows.size > MAX_TRACKED_IPS) {
      for (const [key, value] of windows) {
        if (now >= value.resetAt) windows.delete(key);
      }
      // If all entries are still active (not expired), evict the oldest window
      // to guarantee the map never exceeds MAX_TRACKED_IPS. The current IP is
      // excluded from the candidates (see the factory comment above).
      if (windows.size > MAX_TRACKED_IPS) {
        let oldestKey: string | null = null;
        let oldestReset = Infinity;
        for (const [k, v] of windows) {
          if (k !== ip && v.resetAt < oldestReset) {
            oldestReset = v.resetAt;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) windows.delete(oldestKey);
      }
    }

    res.setHeader('X-RateLimit-Limit', String(options.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: options.tooManyMessage(options.limit, retryAfter),
          type: 'rate_limit_error',
        },
      });
      return;
    }

    next();
  };
}

export function createProxyRateLimiter() {
  return createWindowLimiter({
    limit: parseLimit(),
    windowMs: WINDOW_MS,
    exemptInternal: true,
    tooManyMessage: (limit, retryAfterSec) =>
      `Rate limit exceeded: more than ${limit} requests per minute. Retry in ${retryAfterSec}s.`,
  });
}

/** Per-IP fixed-window rate limiter for arbitrary routes (e.g. /api/auth/login).
 *  Reuses the same window logic as the proxy limiter but with a smaller limit
 *  and a JSON error shape that suits dashboard endpoints. */
export function createPerIpLimiter(limit: number, windowMs: number = WINDOW_MS) {
  return createWindowLimiter({
    limit,
    windowMs,
    tooManyMessage: (_limit, retryAfterSec) => `Too many requests. Retry in ${retryAfterSec}s.`,
  });
}
