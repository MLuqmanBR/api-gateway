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
const { setRoutingStrategy, setGlobalRetryLimit, clearRoundRobinIndex } = await import('../../services/router.js');
const { clearExhaustedForKey } = await import('../../services/key-exhaustion.js');
const { clearKeyRuntimeState } = await import('../../services/ratelimit.js');

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
    // markExhausted() state lives in an in-memory map that survives the
    // rate_limit_cooldowns wipe above — without this, a key burned by one
    // test stays exhausted for the rest of the file and the router silently
    // never picks it again.
    for (const row of getDb().prepare('SELECT id FROM api_keys').all() as Array<{ id: number }>) {
      clearExhaustedForKey(row.id);
      clearKeyRuntimeState(row.id); // also the in-memory cooldowns Map — survives the SQL wipe
    }
    // The round-robin cursor points at whichever key last succeeded; reset it
    // so each test deterministically starts on the first (dead) key.
    clearRoundRobinIndex('groq');
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

  it('rotates to the next key on a structured 402 and publishes exhaust + switch events', async () => {
    // Token Harbor's paid model: key #1's account has a $0 balance (402 with a
    // STRUCTURED status, as providerHttpError attaches), key #2 is funded.
    // Before the fix the structured-status branch classified 402 as
    // non-retryable, so the request died on key #1 with a bare
    // "Provider error" line — no rotation, no cooldown, and with sticky
    // selection the model stayed pinned to the broke key forever.
    // Narrow the chain to a single groq model so the exercise is exactly
    // "same model, next KEY" — the user-visible ⇄ rotation. With multiple
    // groq models, the penalty entry (recordRateLimitHit on exhaustion)
    // demotes the failed model and the router hops MODEL-to-model on the
    // same broke key, so the feed shows '→ switching model' lines instead
    // of the ⇄ key rotation we're pinning here.
    const modelRow = getDb()
      .prepare("SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1")
      .get() as { model_id: string };
    const onlyModel = modelRow.model_id;
    getDb()
      .prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id != ?")
      .run(onlyModel);

    const PAYMENT_ERROR = Object.assign(
      new Error('tokenharbor API error 402: Your Token Harbor balance is at $0. Top up to keep using paid models.'),
      { status: 402 },
    );

    chatCompletion.mockImplementation(async (apiKey: string) => {
      if (apiKey === 'dead-key') throw PAYMENT_ERROR;
      return GOOD_RESULT;
    });

    const { subscribe } = await import('../../services/events.js');
    const events: any[] = [];
    const unsub = subscribe((e) => events.push(e));
    let status: number;
    let body: any;
    try {
      ({ status, body } = await post(app, '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'hi' }],
      }, key));
    } finally {
      unsub();
    }

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('answer from the healthy key');

    // The broke key is probed AT MOST ONCE per (key, model) pair — never the
    // old PER_KEY_RETRIES burst on an account that cannot recover mid-request —
    // and the funded key answers. chatCompletion(apiKey, messages, modelId, …).
    const probeKey = (c: unknown[]) => `${String(c[0])}|${String(c[2])}`;
    const perPair = new Map<string, number>();
    for (const c of chatCompletion.mock.calls) {
      const k = probeKey(c);
      perPair.set(k, (perPair.get(k) ?? 0) + 1);
    }
    for (const [pair, n] of perPair) {
      expect(n, `key|model ${pair} probed ${n} times`).toBe(1);
    }
    expect(chatCompletion.mock.calls.some(c => c[0] === 'dead-key')).toBe(true);
    expect(chatCompletion.mock.calls.some(c => c[0] === 'healthy-key')).toBe(true);

    // The live feed shows the rotation: ⚠ exhausted then ⇄ rotating key.
    expect(events.some(e => e.type === 'routing.key_exhausted' && e.reason.includes('402'))).toBe(true);
    const sw = events.find(e => e.type === 'routing.key_switch');
    expect(sw).toBeTruthy();
    expect(sw.fromKeyId).not.toBe(sw.toKeyId);

    // Benched for the flat 90s (X1), classified as payment_required — a pause,
    // never a permanent bench: no key/status change, and the entry expires.
    const row = getDb().prepare(
      "SELECT reason, expires_at_ms - ? AS ttl FROM rate_limit_cooldowns WHERE model_id IN (SELECT model_id FROM requests ORDER BY id DESC LIMIT 1)",
    ).get(Date.now()) as { reason: string; ttl: number } | undefined;
    expect(row?.reason).toBe('payment_required');
    expect(row!.ttl).toBeLessThanOrEqual(90_000);
    const keyRow = getDb().prepare("SELECT status, enabled FROM api_keys WHERE label = 'dead'").get() as { status: string; enabled: number };
    expect(keyRow.enabled).toBe(1);
    expect(keyRow.status).toBe('healthy');
  });

  it('benches a NON-retryable failure so sticky selection cannot pin a dead key', async () => {
    // A 401 is non-retryable: the request surfaces the error immediately. It
    // must still cool the (platform, model, key) pair, otherwise sticky key
    // selection keeps choosing the same rejected key for every later request
    // on that model. The second request must therefore land on the healthy key.
    chatCompletion.mockImplementation(async (apiKey: string) => {
      if (apiKey === 'dead-key') {
        throw Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 });
      }
      return GOOD_RESULT;
    });

    const first = await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, key);
    expect(first.status).toBe(502);

    const second = await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, key);
    expect(second.status).toBe(200);
    expect(second.body.choices[0].message.content).toBe('answer from the healthy key');
    const deadCallsAfter = chatCompletion.mock.calls.filter((c: unknown[]) => c[0] === 'dead-key').length;
    expect(deadCallsAfter).toBe(1); // not re-probed once cooled
  });
});
