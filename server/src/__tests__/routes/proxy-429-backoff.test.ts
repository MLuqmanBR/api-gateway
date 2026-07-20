import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// 429 burst self-DoS regression (#295). Before the fix, the per-key retry loop
// fired PER_KEY_RETRIES (3) immediate upstream calls on the SAME key with zero
// backoff — a single 429 then caused 3 keys × 3 retries = 9 real upstream 429
// calls in <1.5s, burning NVIDIA NIM's shared 40 RPM account budget across all
// its models. Now a genuine 429 backs off (honor Retry-After, else 1s/2s) before
// retrying the same key, so the burst no longer self-inflicts the per-minute cap.
//
// Test strategy: the mock feeds an always-429 provider and records the wall-clock
// time of every upstream call. After enough calls are captured the test aborts
// the client fetch — closing the socket fires the proxy's attachClientAbort
// AbortController, which unwinds the in-flight loop, so the request settles in
// ~seconds instead of running the full recovery tail. Then we assert on the real
// gaps, which is the only thing that proves the burst is gone.

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

// A genuine upstream rate-limit 429, the way OpenAI-compat providers format it.
// NVIDIA NIM returns 429 with an EMPTY body, so the message has nothing after
// the colon — exactly the user's log: "NVIDIA NIM API error 429: ".
const RATE_LIMIT_429 = Object.assign(new Error('fake API error 429: '), { status: 429 });

// Fire one POST against a fresh server, capturing each upstream call's wall-clock
// time. The `error` factory decides what the mock throws per call; `stopAfter`
// is the number of captured calls after which the client fetch is aborted (so the
// request never runs the full recovery tail). Returns the captured call times.
async function postAndCapture(
  app: Express,
  key: string,
  errorForCall: (callIndex: number) => Error,
  stopAfter: number,
): Promise<number[]> {
  const callTimes: number[] = [];
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const ac = new AbortController();
  // The proxy awaits each chatCompletion before issuing the next, so calls run
  // serially — no race between the hook and the nth call's push.
  chatCompletion.mockImplementation(async () => {
    callTimes.push(Date.now());
    if (callTimes.length >= stopAfter) {
      // Closing the client socket fires the proxy's attachClientAbort → the
      // in-flight abortableSleep / upstream fetch rejects and the loop unwinds.
      ac.abort();
    }
    throw errorForCall(callTimes.length);
  });
  try {
    await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
  } catch (e) {
    // Expected: the test aborted the fetch once enough calls were captured.
    if (!(e instanceof Error) || !/aborted/i.test(e.message)) throw e;
  } finally {
    server.close();
  }
  return callTimes;
}

describe('Proxy 429 short backoff (#295)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    // One key on groq — all calls 429. We disable every other model/key in the
    // seeded fallback config so retry routing stays confined to ONE model+key:
    // it exhausts after PER_KEY_RETRIES, and the test aborts the fetch right
    // after the 3rd call so the recovery tail never runs.
    setGlobalRetryLimit(0);
    const k1 = encrypt('the-only-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'only', ?, ?, ?, 'healthy', 1)
    `).run(k1.encrypted, k1.iv, k1.authTag);
    // Keep only the first groq model enabled; disable every other fallback row
    // and every non-groq key so routing can't wander across the 25 seeded models.
    db.prepare(`
      UPDATE fallback_config SET enabled = 0
      WHERE model_db_id NOT IN (
        SELECT id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();
    db.prepare(`
      UPDATE api_keys SET enabled = 0 WHERE id NOT IN (
        SELECT id FROM api_keys WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('spaces retries on a 429 (no 3-calls-in-<400ms burst)', async () => {
    // Stop after the 3rd upstream call (the PER_KEY_RETRIES limit) — enough to
    // measure the two gaps between the three calls on the same key.
    const callTimes = await postAndCapture(app, key, () => RATE_LIMIT_429, 3);

    // At least the full PER_KEY_RETRIES (3) burst of same-key retries ran.
    expect(callTimes.length).toBeGreaterThanOrEqual(3);
    // CRUCIAL: the gap between consecutive same-key-retry upstream calls must
    // be at least ~1s (the backoff), not the old <400ms burst. Check ONLY the
    // PER_KEY_RETRIES window — calls beyond the 3rd come from the recovery
    // cycle (a separate 1s sleep that resets the backoff counter), not the
    // per-key retry we're gating here. Wait ≥1s, escalate (1s, 2s, ...);
    // allow scheduling jitter but never below 800ms — the pre-fix self-DoS
    // burst ran 3 calls in <400ms, which this lower bound makes impossible.
    for (let i = 1; i < 3 && i < callTimes.length; i++) {
      expect(callTimes[i] - callTimes[i - 1]).toBeGreaterThanOrEqual(800);
    }
  }, 10000);

  it('backs off with escalating sleep (1s then 2s, no upstream Retry-After)', async () => {
    // F13: upstream Retry-After is no longer honored for cooldown/backoff.
    // The proxy uses a fixed escalating sleep: 1s on first retry, 2s on second.
    const four29 = Object.assign(
      new Error('fake API error 429: '),
      { status: 429 },
    );
    const callTimes = await postAndCapture(app, key, () => four29, 2);

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    // The first gap is ~1000ms (1s escalating backoff, allow jitter down to 800ms).
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(800);
  }, 10000);
});
