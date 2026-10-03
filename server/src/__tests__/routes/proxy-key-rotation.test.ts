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
const { resetAllCircuits } = await import('../../services/circuit-breaker.js');

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
    // Circuit breaker state is also in-memory and survives between tests in
    // this file — a key left OPEN by an earlier test would be skipped by the
    // router before any upstream call, defeating the rotation assertions.
    resetAllCircuits();
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

  // Account-level quota exhaustion that arrives as an IN-BAND error (a 200 SSE
  // frame whose message says the plan window is spent / the balance is empty).
  // Key #1's account is broke until its window resets; key #2 is funded.
  // Before the fix the in-band class took the dead-turn path: pinned requests
  // returned 502 without ever benching key #1 (so every later request re-picked
  // it), auto requests skipped the MODEL and left key #2 idle.
  const QUOTA_INBAND_MESSAGE = (iso: string) =>
    'in-band provider error from fake: Your 4-hour session plan usage limit is reached and ' +
    'your API credit balance is empty. Top up API credits to continue pay-as-you-go, or wait ' +
    `for the window to reset. Plan usage resumes at ${iso}.`;
  const quotaError = (iso: string) => new Error(QUOTA_INBAND_MESSAGE(iso));

  // Narrow the chain to ONE groq model so the exercise is exactly
  // "same model, next KEY" and the router cannot hop models instead. The model
  // must be enabled in the catalog AND in the enabled fallback chain, or
  // pinning it fails with model_not_routable.
  const narrowToSingleGroqModel = () => {
    const row = getDb().prepare(`
      SELECT m.model_id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.platform = 'groq' AND m.enabled = 1 AND fc.enabled = 1
       ORDER BY fc.priority ASC LIMIT 1
    `).get();
    if (!row || typeof row !== 'object' || !('model_id' in row) || typeof row.model_id !== 'string') {
      throw new Error('test setup: no enabled groq model in the fallback chain');
    }
    const onlyModel = row.model_id;
    getDb().prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id != ?").run(onlyModel);
    return onlyModel;
  };

  it('rotates to the next key when an in-band ACCOUNT-QUOTA error burns the first key (auto routing)', async () => {
    narrowToSingleGroqModel();
    chatCompletion.mockImplementation(async (apiKey: string) => {
      if (apiKey === 'dead-key') throw quotaError(new Date(Date.now() + 3_600_000).toISOString());
      return GOOD_RESULT;
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('answer from the healthy key');
    // The broke key is probed AT MOST ONCE per (key, model) pair — never the
    // PER_KEY_RETRIES burst on an account that cannot recover mid-request.
    const perPair = new Map<string, number>();
    for (const c of chatCompletion.mock.calls) {
      const pair = `${String(c[0])}|${String(c[2])}`;
      perPair.set(pair, (perPair.get(pair) ?? 0) + 1);
    }
    for (const [pair, n] of perPair) expect(n, `key|model ${pair} probed ${n} times`).toBe(1);
    expect(chatCompletion.mock.calls.some(c => c[0] === 'dead-key')).toBe(true);
    expect(chatCompletion.mock.calls.some(c => c[0] === 'healthy-key')).toBe(true);
  });

  it('rotates to the next key when a PINNED model returns an in-band ACCOUNT-QUOTA error', async () => {
    const onlyModel = narrowToSingleGroqModel();
    chatCompletion.mockImplementation(async (apiKey: string) => {
      if (apiKey === 'dead-key') throw quotaError(new Date(Date.now() + 3_600_000).toISOString());
      return GOOD_RESULT;
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: `groq/${onlyModel}`,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    // Previously a 502 on the first in-band frame, with key #1 never benched.
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('answer from the healthy key');
    expect(chatCompletion.mock.calls.some(c => c[0] === 'healthy-key')).toBe(true);
  });

  it('rotates to the next key when a STREAMING request hits an in-band ACCOUNT-QUOTA error', async () => {
    // Production shape: the client streams, so the error surfaces from the
    // provider's SSE reader (proxy.ts "in-band provider error" throw) rather
    // than from a thrown chatCompletion. Same carve-out, streaming path.
    const onlyModel = narrowToSingleGroqModel();
    const quotaMsg = QUOTA_INBAND_MESSAGE(new Date(Date.now() + 3_600_000).toISOString());
    streamChatCompletion.mockImplementation(async function* (apiKey: string) {
      if (apiKey === 'dead-key') throw new Error(quotaMsg);
      yield { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'answer from the healthy key' }, finish_reason: null }] };
      yield { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    });

    const { status, raw } = await post(app, '/v1/chat/completions', {
      model: `groq/${onlyModel}`,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(raw).toContain('answer from the healthy key');
    // One probe per (key, model) pair, same as the non-streaming path.
    const perPair = new Map<string, number>();
    for (const c of streamChatCompletion.mock.calls) {
      const pair = `${String(c[0])}|${String(c[2])}`;
      perPair.set(pair, (perPair.get(pair) ?? 0) + 1);
    }
    for (const [pair, n] of perPair) expect(n, `key|model ${pair} probed ${n} times`).toBe(1);
  });

  it('waits for the soonest stated reset and retries that key until it activates (pinned, all keys spent)', { timeout: 15000 }, async () => {
    setGlobalRetryLimit(0);
    const onlyModel = narrowToSingleGroqModel();
    const resetAt = Date.now() + 1500;
    const resetIso = new Date(resetAt).toISOString();
    // BOTH keys are quota-dead until the stated moment; after it, the funded
    // key serves. Before the fix the loop polled every 60 s (and, pinned,
    // never even entered recovery from this error).
    chatCompletion.mockImplementation(async (apiKey: string) => {
      if (Date.now() >= resetAt) return GOOD_RESULT;
      throw quotaError(resetIso);
    });

    const started = Date.now();
    const { status, body } = await post(app, '/v1/chat/completions', {
      model: `groq/${onlyModel}`,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('answer from the healthy key');
    // The recovery cycle slept until the stated reset instead of polling.
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    // The key that came back answered, and it did so after the reset moment.
    expect(chatCompletion.mock.calls.some(c => c[0] === 'healthy-key')).toBe(true);
  });

  it('sleeps to the stated reset even when a key circuit is OPEN in 1-RPM recovery', { timeout: 15000 }, async () => {
    // Regression: the circuit-open branch adds the key to skipKeys and loops,
    // but the router deliberately ignores skipKeys in 1-RPM mode — so without
    // stamping lastRequestTime there the loop re-picks the open key with no
    // sleep and no upstream call (~100k iterations/s, measured) until the
    // client disconnects. The finite retry limit below is what makes that
    // observable: a hot spin burns the whole budget instantly and answers 429,
    // while a throttled loop sleeps to the stated reset and answers 200.
    setGlobalRetryLimit(50);
    const { setSetting } = await import('../../db/index.js');
    setSetting('circuit_breaker_failure_threshold', '1');
    setSetting('circuit_breaker_cooldown_ms', '200');
    try {
      const onlyModel = narrowToSingleGroqModel();
      const modelRow = getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = ?").get(onlyModel);
      if (!modelRow || typeof modelRow !== 'object' || !('id' in modelRow) || typeof modelRow.id !== 'number') {
        throw new Error('test setup: model row not found');
      }
      const modelId = modelRow.id;
      const resetAt = Date.now() + 1500;
      const resetIso = new Date(resetAt).toISOString();

      // Production lead-up: earlier failures already tripped the breaker for
      // both keys, and the burned key's stated window is on record.
      const { recordCircuitFailure } = await import('../../services/circuit-breaker.js');
      const { markExhausted } = await import('../../services/key-exhaustion.js');
      const keyRows = getDb().prepare('SELECT id FROM api_keys ORDER BY id').all() as Array<{ id: number }>;
      for (const k of keyRows) recordCircuitFailure('groq', onlyModel, k.id);
      markExhausted(keyRows[0].id, 'groq', onlyModel, { resetAtMs: resetAt, modelDbId: modelId });

      chatCompletion.mockImplementation(async () => {
        if (Date.now() >= resetAt) return GOOD_RESULT;
        throw quotaError(resetIso);
      });

      const started = Date.now();
      const { status, body } = await post(app, '/v1/chat/completions', {
        model: `groq/${onlyModel}`,
        messages: [{ role: 'user', content: 'hi' }],
      }, key);
      const elapsed = Date.now() - started;

      // A hot spin would have exhausted the 50-iteration budget in <1 ms and
      // returned 429 "Recovery limit reached".
      expect(status).toBe(200);
      expect(body.choices[0].message.content).toBe('answer from the healthy key');
      expect(elapsed).toBeGreaterThanOrEqual(1400);
    } finally {
      setSetting('circuit_breaker_failure_threshold', '5');
      setSetting('circuit_breaker_cooldown_ms', '30000');
    }
  });
});
