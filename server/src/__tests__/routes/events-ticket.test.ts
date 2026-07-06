import { describe, it, expect } from 'vitest';
import { mintTicket, consumeTicket } from '../../routes/events.js';

// #43: short-lived single-use tickets let a remote EventSource authenticate
// without putting the long-lived session token in the query string.
describe('SSE events ticket', () => {
  it('mints a ticket that consumes exactly once', () => {
    const t = mintTicket();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(0);
    // First consume succeeds…
    expect(consumeTicket(t)).toBe(true);
    // …reuse fails (single-use).
    expect(consumeTicket(t)).toBe(false);
  });

  it('rejects an unknown or empty ticket', () => {
    expect(consumeTicket(undefined)).toBe(false);
    expect(consumeTicket('')).toBe(false);
    expect(consumeTicket('not-a-real-ticket')).toBe(false);
  });

  it('rejects an expired ticket (and consumes it so it cannot be retried)', () => {
    const now = 1_000_000;
    const t = mintTicket(now);
    // TTL is <= 60s; a consume one hour later must fail as expired.
    expect(consumeTicket(t, now + 60 * 60 * 1000)).toBe(false);
    // Even trying again within the (original) validity window fails — the
    // expired attempt already consumed it.
    expect(consumeTicket(t, now + 1000)).toBe(false);
  });

  it('issues distinct tickets that each consume independently', () => {
    const a = mintTicket();
    const b = mintTicket();
    expect(a).not.toBe(b);
    expect(consumeTicket(b)).toBe(true);
    // Consuming b did not consume a.
    expect(consumeTicket(a)).toBe(true);
  });
});
