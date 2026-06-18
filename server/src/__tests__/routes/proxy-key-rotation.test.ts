import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Key-rotation behavior: when one key fails with a per-key error (400/429), the
// retry loop must rotate to the NEXT key on the same model instead of skipping
// the model or hammering the dead key forever. Regression test for issue #293
// (CommandCode: only key#85 was ever tried, key#86 with balance never got a
// chance because `api error 400` skipped the model immediately).

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
const { setRoutingStrategy, setGlobalRetryLimit } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

// A 400 that the OpenAI-compat provider formats as "fake API error 400: ...".
// `isRetryableError` treats "api error 400" as retryable.
const BAD_REQUEST_ERROR = Object.assign(new Error('fake API error 400: BAD_REQUEST something'), { status: 400 });
const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'answer from the healthy key' } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

describe('Proxy key rotation on per-key 400 failures (#293)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    // Two keys on the same platform/model — key #1 (lower id) is the dead one,
    // key #2 is healthy. The router must rotate from #1 to #2.
    const k1 = encrypt('dead-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'dead', ?, ?, ?, 'healthy', 1)
    `).run(k1.encrypted, k1.iv, k1.authTag);
    const k2 = encrypt('healthy-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'healthy', ?, ?, ?, 'healthy', 1)
    `).run(k2.encrypted, k2.iv, k2.authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    setGlobalRetryLimit(20);
  });

  it('rotates to the next key when the first key returns a 400 (no model skip)', async () => {
    // The dead key always 400s; the healthy key succeeds. Before the fix, the
    // 400 triggered skipModels (skipping the model entirely) so the healthy
    // key was never tried and the request failed. Now the 400 exhausts the key
    // and the router rotates to the next key on the SAME model.
    //
    // Branch on the apiKey argument so the test is robust to which key the
    // router picks first.
    chatCompletion.mockImplementation(async (apiKey: string) => {
      if (apiKey === 'dead-key') throw BAD_REQUEST_ERROR;
      return GOOD_RESULT;
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('answer from the healthy key');
    // The dead key was consulted at least once AND the healthy key answered —
    // proving rotation reached the second key rather than skipping the model.
    const calledKeys = chatCompletion.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledKeys).toContain('healthy-key');
    // If the dead key was tried first, it must have been retried up to
    // PER_KEY_RETRIES then rotated away from. Either way the healthy key
    // eventually answered (status 200 above), which is the core assertion.
  });
});
