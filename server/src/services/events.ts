/**
 * In-process event bus for live routing transparency.
 *
 * The proxy publishes routing decisions here; SSE subscribers (the dashboard
 * live feed) consume them in real time. Events are fire-and-forget — no
 * subscriber can block the proxy, and dropped events are silently ignored.
 *
 * Capacity is capped so a stalled SSE client never balloons memory.
 */
import type { Response } from 'express';
import type { KeyStatus } from '@api-gateway/shared/types.js';

export type LiveEvent =
  | { type: 'request.start'; id: string; model?: string; stream: boolean; at: number }
  | { type: 'request.done'; id: string; model: string; provider: string; keyId: number; latencyMs: number; tokens?: { in: number; out: number }; at: number }
  | { type: 'request.error'; id: string; error: string; at: number }
  | { type: 'request.aborted'; id: string; at: number }
  | { type: 'routing.key_exhausted'; id: string; provider: string; keyId: number; model: string; reason: string; at: number }
  | { type: 'routing.key_retry'; id: string; provider: string; keyId: number; model: string; attempt: number; max: number; at: number }
  // Key switched within the same model after the previous key was exhausted.
  // Distinct from `routing.model_switch` (which fires when the model itself
  // changes) so the live terminal can show the user that the proxy rotated
  // to a sibling key rather than a different model entirely. (#256)
  | { type: 'routing.key_switch'; id: string; provider: string; model: string; fromKeyId: number; toKeyId: number; at: number }
  | { type: 'routing.model_switch'; id: string; from: string; to: string; reason: string; at: number }
  | { type: 'routing.recovery'; id: string; cycle: number; max: number | null; reason: string; at: number }
  | { type: 'stream.chunk'; id: string; text: string; at: number }
  // Middle-layer interceptor (privacy layer B2-4). The interceptor makes
  // its own AI call to scan messages for new secrets — these events make
  // that call visible in the live feed and the analytics dashboard, the
  // same way chat/embedding requests are. (#B2-4)
  | { type: 'interceptor.start'; id: string; model: string; provider: string; at: number }
  | { type: 'interceptor.done'; id: string; model: string; provider: string; keyId: number; latencyMs: number; secretsFound: number; at: number }
  | { type: 'interceptor.error'; id: string; model: string; provider: string; error: string; at: number }
  // Health-check progress. The KeysPage subscribes to these so the "Check
  // all" button can show live per-key results instead of a frozen
  // "Checking…" spinner that gave the operator zero feedback for 15+
  // minutes on a 89-key fleet. The `id` is synthetic (set by the
  // publisher in health.ts) because these events aren't request-scoped
  // — they describe a background sweep. (#256)
  | { type: 'health.check.start'; id: string; total: number; concurrency: number; at: number }
  | { type: 'health.check.progress'; id: string; keyId: number; platform: string; status: KeyStatus; completed: number; total: number; at: number }
  | { type: 'health.check.done'; id: string; total: number; at: number };

const MAX_SUBSCRIBERS = 8;

// Value is a teardown invoked when a subscriber is evicted for capacity (NOT
// on a normal unsubscribe — the returned unsubscribe function just removes
// the entry). Pure `subscribe` callers get a default no-op teardown so an
// eviction never throws or has any effect beyond dropping the listener.
const subscribers = new Map<(evt: LiveEvent) => void, () => void>();

export function publish(evt: LiveEvent): void {
  for (const fn of subscribers.keys()) {
    try { fn(evt); } catch { /* subscriber error — drop */ }
  }
}

const noopTeardown = () => {};

/** Add a listener and return an unsubscribe function.
 *
 * Capacity policy: allow up to {@link MAX_SUBSCRIBERS} concurrent listeners.
 * When a new subscription would push the count over that cap, the OLDEST
 * subscriber (first-inserted) is evicted — that one is most likely a stale
 * tab still holding a socket but no longer rendering. The evicted entry's
 * `teardown` is invoked so any resources it holds (SSE heartbeat timer,
 * HTTP response) are released rather than left open with no listener.
 *
 * Exported so the multi-subscriber invariant is testable without booting
 * Express. `subscribeSse` is a thin wrapper for the SSE use-case. */
export function subscribe(fn: (evt: LiveEvent) => void, teardown: () => void = noopTeardown): () => void {
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    const firstKey = subscribers.keys().next().value;
    if (firstKey) {
      const firstTeardown = subscribers.get(firstKey);
      subscribers.delete(firstKey);
      try { firstTeardown?.(); } catch { /* evicted subscriber's teardown failed — drop */ }
    }
  }
  subscribers.set(fn, teardown);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    subscribers.delete(fn);
  };
}

/** Register an SSE response as a subscriber. Returns an unsubscribe function. */
export function subscribeSse(res: Response): () => void {
  // Heartbeat every 30s to keep the connection alive through proxies.
  // Tests for the eviction/limit behaviour don't need the timer — the
  // pure `subscribe` API above is what they exercise, and the timer is
  // paid for only by the real prod code path.
  // N24: check headersSent BEFORE writing — if the subscriber registered
  // before the route flushed headers, a heartbeat here would commit the
  // response as SSE and freeze whatever status/headers the route later sets.
  const heartbeat = setInterval(() => {
    if (res.destroyed || !res.headersSent) return;
    try { res.write(': heartbeat\n\n'); } catch { /* socket gone */ }
  }, 30_000);

  const cleanupSub = subscribe((evt: LiveEvent) => {
    if (res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      /* socket gone; the 'close' handler will tear down the listener */
    }
  }, () => {
    // Evicted for capacity: this response no longer receives events, so
    // stop the heartbeat and end the connection instead of leaving it open
    // and silently dead.
    clearInterval(heartbeat);
    try { res.end(); } catch { /* already gone */ }
  });

  // Tear down promptly when the client disconnects: stop the heartbeat and
  // drop the listener so a stalled-but-not-closed socket doesn't keep
  // getting fed events forever. (Listener is already auto-removed when
  // `res.destroyed` becomes true and it errors, but a soft `socket close`
  // event sometimes leaves that flag unset; close-handler is the safety net.)
  res.on('close', () => {
    clearInterval(heartbeat);
    cleanupSub();
  });

  return () => {
    clearInterval(heartbeat);
    cleanupSub();
  };
}
