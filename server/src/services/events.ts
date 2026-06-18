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

export type LiveEvent =
  | { type: 'request.start'; id: string; model?: string; stream: boolean; at: number }
  | { type: 'request.done'; id: string; model: string; provider: string; keyId: number; latencyMs: number; tokens?: { in: number; out: number }; at: number }
  | { type: 'request.error'; id: string; error: string; at: number }
  | { type: 'request.aborted'; id: string; at: number }
  | { type: 'routing.key_exhausted'; id: string; provider: string; keyId: number; model: string; reason: string; at: number }
  | { type: 'routing.key_retry'; id: string; provider: string; keyId: number; model: string; attempt: number; max: number; at: number }
  | { type: 'routing.model_switch'; id: string; from: string; to: string; reason: string; at: number }
  | { type: 'routing.recovery'; id: string; cycle: number; max: number | null; reason: string; at: number }
  | { type: 'stream.chunk'; id: string; text: string; at: number };

const MAX_SUBSCRIBERS = 8;

const subscribers = new Set<(evt: LiveEvent) => void>();

export function publish(evt: LiveEvent): void {
  for (const fn of subscribers) {
    try { fn(evt); } catch { /* subscriber error — drop */ }
  }
}

/** Add a listener and return an unsubscribe function.
 *
 * Capacity policy: allow up to {@link MAX_SUBSCRIBERS} concurrent listeners.
 * When a new subscription would push the count over that cap, the OLDEST
 * subscriber (first-inserted) is evicted — that one is most likely a stale
 * tab still holding a socket but no longer rendering.
 *
 * Exported so the multi-subscriber invariant is testable without booting
 * Express. `subscribeSse` is a thin wrapper for the SSE use-case. */
export function subscribe(fn: (evt: LiveEvent) => void): () => void {
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    const first = subscribers.values().next().value;
    if (first) subscribers.delete(first);
  }
  subscribers.add(fn);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    subscribers.delete(fn);
  };
}

/** Register an SSE response as a subscriber. Returns an unsubscribe function. */
export function subscribeSse(res: Response): () => void {
  const cleanupSub = subscribe((evt: LiveEvent) => {
    if (res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      /* socket gone; the 'close' handler will tear down the listener */
    }
  });

  // Heartbeat every 30s to keep the connection alive through proxies.
  // Tests for the eviction/limit behaviour don't need the timer — the
  // pure `subscribe` API above is what they exercise, and the timer is
  // paid for only by the real prod code path.
  const heartbeat = setInterval(() => {
    if (res.destroyed) return;
    try { res.write(': heartbeat\n\n'); } catch { /* socket gone */ }
  }, 30_000);

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
