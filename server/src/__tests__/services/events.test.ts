import { describe, expect, it, beforeEach } from 'vitest';
import { publish, subscribe, type LiveEvent } from '../../services/events.js';

describe('events service', () => {
  // Each test gets its own subscriber Set; tests below stack, so we drain
  // leftover listeners defensively before/after to keep them isolated.
  const collected: Array<{ listener: (e: LiveEvent) => void; seen: LiveEvent[] }> = [];
  const unsubscribers: Array<() => void> = [];

  function makeListener() {
    const seen: LiveEvent[] = [];
    const listener = (e: LiveEvent) => seen.push(e);
    collected.push({ listener, seen });
    const off = subscribe(listener);
    unsubscribers.push(off);
    return { listener, seen, off };
  }

  beforeEach(() => {
    collected.length = 0;
    unsubscribers.length = 0;
  });

  it('delivers every published event to every active subscriber', () => {
    const a = makeListener();
    const b = makeListener();
    const evt: LiveEvent = { type: 'request.aborted', id: 'svc-1', at: 1 };
    publish(evt);
    expect(a.seen).toEqual([evt]);
    expect(b.seen).toEqual([evt]);
  });

  it('keeps multiple subscribers alive after a publish (does not evict the older one)', () => {
    // Regression for the bumped "first subscriber gets evicted on every connect"
    // bug: with two concurrent listeners we expect both to keep receiving
    // events through the subscription lifetime, not just the second one.
    // The eviction policy only fires past MAX_SUBSCRIBERS=8, so two listeners
    // is the canonical case that USED to misbehave.
    const a = makeListener();
    const b = makeListener();
    const first: LiveEvent = { type: 'request.start', id: 'svc-2', stream: true, at: 1 };
    const second: LiveEvent = { type: 'request.done', id: 'svc-2', model: 'm', provider: 'p', keyId: 1, latencyMs: 10, at: 2 };
    publish(first);
    publish(second);
    expect(a.seen.map(e => e.type)).toEqual(['request.start', 'request.done']);
    expect(b.seen.map(e => e.type)).toEqual(['request.start', 'request.done']);
  });

  it('publishes the wire shape for every typed variant the client union knows about', () => {
    // Defensive: a server-side event type that is missing from the client
    // union (the bug that triggered the actual production crash) would
    // surface here as an additive, non-throwing type. Each published event
    // MUST round-trip through `subscribe` without throwing on either side.
    const a = makeListener();
    const samples: LiveEvent[] = [
      { type: 'request.start', id: 'a', stream: true, at: 1 },
      { type: 'request.done', id: 'a', model: 'm', provider: 'p', keyId: 1, latencyMs: 10, at: 2 },
      { type: 'request.error', id: 'a', error: 'boom', at: 3 },
      // The exact event type that used to crash the dashboard before the
      // formatEvent fix landed.
      { type: 'request.aborted', id: 'a', at: 4 },
      { type: 'routing.key_exhausted', id: 'a', provider: 'p', keyId: 1, model: 'm', reason: 'r', at: 5 },
      { type: 'routing.key_retry', id: 'a', provider: 'p', keyId: 1, model: 'm', attempt: 1, max: 3, at: 6 },
      { type: 'routing.model_switch', id: 'a', from: 'a', to: 'b', reason: 'r', at: 7 },
      { type: 'routing.recovery', id: 'a', cycle: 1, max: 5, reason: 'r', at: 8 },
      { type: 'stream.chunk', id: 'a', text: 'hello', at: 9 },
    ];
    for (const evt of samples) publish(evt);
    expect(a.seen.length).toBe(samples.length);
    expect(a.seen.map(e => e.type)).toEqual(samples.map(e => e.type));
  });

  it('drops a subscriber once unsubscribed and never delivers further events', () => {
    const a = makeListener();
    const off = a.off;
    off();
    publish({ type: 'request.aborted', id: 'x', at: 1 });
    expect(a.seen).toEqual([]);
    off(); // idempotent
    expect(a.seen).toEqual([]);
  });
});
