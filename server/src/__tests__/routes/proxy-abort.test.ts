import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Abort + attempt-limit behavior for /v1/chat/completions. A client disconnect
// (Stop / session close) must (a) cancel the in-flight upstream call and
// (b) break out of the retry loop instead of grinding through every key/model.
// The global recovery limit must count ACTUAL upstream attempts and stop early.
// (#292)

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy, setGlobalRetryLimit, getGlobalRetryLimit } = await import('../../services/router.js');

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'a real answer' } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};
const RATE_LIMIT_ERROR = Object.assign(new Error('fake API error 429: rate limit exceeded'), { status: 429 });

async function post(app: Express, path: string, body: any, key: string, opts: { signal?: AbortSignal } = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

describe('Proxy client-disconnect abort + attempt limit', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    // Restore the default recovery limit between tests.
    setGlobalRetryLimit(3);
  });

  it('aborts the retry loop when the client disconnects mid-request', async () => {
    // Every upstream call returns a 429 (retryable) so the loop would keep
    // cycling. We abort the client after the first call lands; the loop must
    // stop immediately instead of burning more attempts.
    let calls = 0;
    chatCompletion.mockImplementation(async () => {
      calls++;
      // Stall briefly so the abort lands while the request is still in flight.
      await new Promise(r => setTimeout(r, 50));
      throw RATE_LIMIT_ERROR;
    });

    const controller = new AbortController();
    const promise = post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key, { signal: controller.signal });

    // Abort shortly after the first upstream call has started.
    setTimeout(() => controller.abort(), 80);
    // A client abort rejects the fetch; swallow it.
    await promise.catch(() => {});

    // Give the loop a beat to observe the abort and unwind.
    await new Promise(r => setTimeout(r, 150));
    const callsAfterAbort = calls;
    await new Promise(r => setTimeout(r, 100));
    // No NEW upstream calls should have happened after the abort landed.
    expect(calls).toBe(callsAfterAbort);
    // And the loop did NOT run away to the full recovery limit.
    expect(calls).toBeLessThan(getGlobalRetryLimit());
  });

  it('stops at the global recovery limit (counts upstream attempts, not cycles)', async () => {
    // Every call 429s. With the limit set to 3, the loop must make at most 3
    // upstream calls total (across every key/model) and then return 429 — NOT
    // the old "3 per key × keys × models" cycle math that produced 100+ calls.
    setGlobalRetryLimit(3);
    chatCompletion.mockImplementation(async () => { throw RATE_LIMIT_ERROR; });

    const { status, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    expect(headers.get('x-upstream-attempts')).toBe('3');
    // The attempt counter caps the actual provider calls — never more than the
    // configured limit.
    expect(chatCompletion.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('completes normally when the client stays connected (no spurious abort)', async () => {
    // Sanity check that the disconnect watcher doesn't fire on a healthy
    // request/response round trip.
    chatCompletion.mockResolvedValueOnce(GOOD_RESULT);

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('a real answer');
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});
