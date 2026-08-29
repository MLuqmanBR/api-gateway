import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Imp 13 regression: 429 burst self-DoS on the Codex path. Before the fix, the
// /v1/responses retry loop benched a key on the FIRST retryable failure with
// zero backoff — a burst of transient 429s benched every key in the fleet
// within seconds (the exact class fixed for /chat/completions in #295 /
// proxy-429-backoff.test.ts). Now a genuine 429 backs off (1s, then 2s — the
// proxy's ceiling) before benching the key and cycling; transient transport
// errors and 5xx keep the immediate cycle.
//
// Test strategy mirrors proxy-429-backoff.test.ts: the mock feeds an
// always-429 provider and records the wall-clock time of every upstream call;
// after enough calls the client fetch is aborted so the request settles fast.
// The real inter-call gaps are the only thing that proves the burst is gone.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as unknown as Record<string, unknown>;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy, setGlobalRetryLimit } from '../../services/router.js';
import { clearPlatformCaches } from '../../services/ratelimit.js';

// A genuine upstream rate-limit 429, the way OpenAI-compat providers format it.
const RATE_LIMIT_429 = Object.assign(new Error('fake API error 429: '), { status: 429 });
// A retryable but NOT rate-limit error (5xx): the control group — must cycle
// keys immediately, because waiting adds latency without helping.
const SERVER_500 = Object.assign(new Error('fake API error 500: '), { status: 500 });

// Fire one POST /v1/responses against a fresh server, capturing each upstream
// call's wall-clock time. `stopAfter` captured calls trigger a client abort so
// the request never runs its full recovery tail. Returns the captured times.
async function postAndCapture(
  app: Express,
  key: string,
  errorForCall: (callIndex: number) => Error,
  stopAfter: number,
): Promise<{ callTimes: number[]; status?: number; resolvedAt?: number }> {
  const callTimes: number[] = [];
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const ac = new AbortController();
  // The route awaits each chatCompletion before routing the next attempt, so
  // calls run serially — no race between the hook and the nth call's push.
  chatCompletion.mockImplementation(async () => {
    callTimes.push(Date.now());
    if (callTimes.length >= stopAfter) {
      // Closing the client socket fires attachClientAbort server-side, which
      // unwinds the retry loop (the in-flight sleep resolves early and the
      // loop-top abort check exits).
      ac.abort();
    }
    throw errorForCall(callTimes.length);
  });
  let status: number | undefined;
  let resolvedAt: number | undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: 'hi' }),
      signal: ac.signal,
    });
    status = res.status;
    resolvedAt = Date.now();
  } catch (e) {
    // Expected: the test aborted the fetch once enough calls were captured.
    if (!(e instanceof Error) || !/aborted/i.test(e.message)) throw e;
  } finally {
    server.close();
  }
  return { callTimes, status, resolvedAt };
}

describe('Responses 429 backoff (Imp 13)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    // Three keys on groq with one model enabled — exactly three routable
    // (model, key) pairs, so the attempt loop makes exactly three upstream
    // calls (with escalating 1s/2s/2s waits between them) before routeRequest
    // throws "all models rate-limited". Everything else stays disabled so
    // routing can't wander across the seeded catalog.
    setGlobalRetryLimit(0);
    for (let i = 0; i < 3; i++) {
      const k = encrypt(`groq-key-${i}`);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
      `).run(`test-${i}`, k.encrypted, k.iv, k.authTag);
    }
    db.prepare(`
      UPDATE fallback_config SET enabled = 0
      WHERE model_db_id NOT IN (
        SELECT id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();
    db.prepare(`
      UPDATE api_keys SET enabled = 0 WHERE platform != 'groq'
    `).run();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    // M11's memory-first cooldown cache survives DB deletes — the prior test's
    // 90s cooldowns would otherwise starve this test's routing. Clear both.
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    clearPlatformCaches('groq');
  });

  it('backs off with escalating sleep (1s then 2s) between 429 attempts', async () => {
    // Capture 3 upstream calls: t1 --1s--> t2 --2s--> t3; the client abort
    // after the 3rd call short-circuits the remaining recovery tail.
    const { callTimes } = await postAndCapture(app, key, () => RATE_LIMIT_429, 3);

    expect(callTimes.length).toBeGreaterThanOrEqual(3);
    // First cycle wait ≈ 1s (allow scheduling jitter down to 800ms — the
    // pre-fix behavior ran consecutive attempts in <400ms, which this lower
    // bound makes impossible).
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(800);
    // Second cycle wait ≈ 2s (escalated) — must be measurably larger than the
    // first and never below 1.8s.
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1800);
  }, 15000);

  it('does NOT wait on non-429 retryable errors (immediate key cycle)', async () => {
    const { callTimes } = await postAndCapture(app, key, () => SERVER_500, 3);

    expect(callTimes.length).toBeGreaterThanOrEqual(3);
    // No backoff for 5xx transport-class failures: every gap stays in the
    // sub-400ms burst regime the 429 path exists to avoid.
    for (let i = 1; i < callTimes.length; i++) {
      expect(callTimes[i] - callTimes[i - 1]).toBeLessThan(400);
    }
  }, 15000);

  afterEach(() => {
    setGlobalRetryLimit(0);
  });

  it('does not sleep on the final attempt (nothing follows to protect)', async () => {
    // attemptLimit 2 with three keys: attempt 0 sleeps ~1s, attempt 1 is the
    // FINAL attempt — its 429 benches the key and exits the loop with no
    // sleep, so the 429 response lands right after the 2nd upstream call.
    setGlobalRetryLimit(2);
    const { callTimes, status, resolvedAt } = await postAndCapture(app, key, () => RATE_LIMIT_429, 99);

    expect(callTimes.length).toBe(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(800); // attempt-0 backoff
    expect(status).toBe(429); // exhausted-all-retries response
    expect(resolvedAt! - callTimes[1]).toBeLessThan(600); // no final-attempt sleep
  }, 15000);

  it('caps cumulative backoff at a 10s budget', async () => {
    // Eleven keys (3 from beforeAll + 8 here) all 429ing with attemptLimit
    // 20: uncapped escalation would sleep 1+2*10 = 21s; the 10s budget holds
    // the total down before routeRequest throws (no keys left) and the 429
    // response returns.
    const db = getDb();
    for (let i = 3; i < 11; i++) {
      const k = encrypt(`groq-key-${i}`);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
      `).run(`test-${i}`, k.encrypted, k.iv, k.authTag);
    }
    const keyCount = (db.prepare(
      "SELECT COUNT(*) AS c FROM api_keys WHERE platform = 'groq' AND enabled = 1",
    ).get() as { c: number }).c;
    const started = Date.now();
    const { callTimes, status } = await postAndCapture(app, key, () => RATE_LIMIT_429, 99);

    expect(callTimes.length).toBe(keyCount); // every key tried, no recovery tail
    expect(status).toBe(429);
    expect(Date.now() - started).toBeLessThan(12500);
  }, 20000);
});
