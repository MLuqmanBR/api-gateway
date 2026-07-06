import { randomBytes } from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { subscribeSse } from '../services/events.js';
import { isTrustedRequest } from '../lib/ip-trust.js';

export const eventsRouter = Router();

// ── Short-lived single-use SSE tickets (#43) ──
// `EventSource` can't send an `Authorization: Bearer` header, so a REMOTE
// (non-LAN) token-authenticated operator can't open /api/events directly. The
// long-lived session token must NOT go in the query string (query strings leak
// into server logs, proxies, and browser history). Instead the client first
// calls the authed GET /api/events/ticket to mint a short-lived, single-use
// ticket, then opens `new EventSource('/api/events?ticket=<t>')`. The stream
// handler validates-and-consumes the ticket when the request isn't LAN-trusted.
const TICKET_TTL_MS = 30_000; // <= 60s per the audit spec
const tickets = new Map<string, number>(); // ticket -> expiry epoch ms

function pruneTickets(now: number): void {
  for (const [t, exp] of tickets) {
    if (exp <= now) tickets.delete(t);
  }
}

/** Mint a short-lived single-use ticket. Exported for tests. */
export function mintTicket(now = Date.now()): string {
  pruneTickets(now);
  const ticket = randomBytes(32).toString('hex');
  tickets.set(ticket, now + TICKET_TTL_MS);
  return ticket;
}

/** Validate and consume a ticket. Returns true exactly once per valid,
 *  unexpired ticket; every reuse or expired/unknown ticket returns false.
 *  Exported for tests. */
export function consumeTicket(ticket: string | undefined, now = Date.now()): boolean {
  if (!ticket) return false;
  const exp = tickets.get(ticket);
  if (exp === undefined) return false;
  tickets.delete(ticket); // single-use: consume regardless of expiry
  return exp > now;
}

/**
 * GET /api/events/ticket — mint a short-lived single-use ticket for the SSE
 * stream. Behind requireAuth (mounted in app.ts), so only an authenticated
 * dashboard session (or LAN-trusted caller) can obtain one.
 */
eventsRouter.get('/ticket', (_req: Request, res: Response) => {
  res.json({ ticket: mintTicket(), expiresInMs: TICKET_TTL_MS });
});

/**
 * GET /api/events — Server-Sent Events stream of live routing activity.
 *
 * The dashboard subscribes to this endpoint for real-time visibility into what
 * the proxy is doing: key exhaustions, retries, model switches, 1 RPM recovery
 * cycles, request successes/failures.
 *
 * Auth: a LAN-trusted caller streams directly (unchanged). A remote caller must
 * present a valid `?ticket=` minted from /api/events/ticket, which this handler
 * validates and consumes. Mounted ABOVE the /api requireAuth blanket in app.ts
 * so the ticket path — not a session header EventSource can't send — is the gate.
 * Up to 8 concurrent subscribers; oldest is evicted when the limit is hit.
 */
export function eventsStreamHandler(req: Request, res: Response): void {
  if (!isTrustedRequest(req)) {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
    if (!consumeTicket(ticket)) {
      res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: don't buffer

  // Send an initial comment so the client knows the stream is alive.
  res.write(': connected\n\n');

  subscribeSse(res);
}
