import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setGlobalRetryLimit } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// requested_model logging: a pinned request records the model id the client
// named; an auto request records NULL. This is what lets analytics split
// pinned vs auto traffic and surface failover overrides.
describe('requested_model analytics logging', () => {
  let app: Express;
  let groqModelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    // Any enabled groq model from the seeded catalog will do as the pin target.
    groqModelId = (getDb().prepare(`
      SELECT m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.platform = 'groq' AND m.enabled = 1
      ORDER BY fc.priority LIMIT 1
    `).get() as { model_id: string }).model_id;
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_pinned_model_test',
      label: 'pinned-model',
    });
    expect(addKey.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-pin', object: 'chat.completion', created: 1, model: groqModelId,
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the pinned model id when the client names a model', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);

    const row = getDb().prepare('SELECT model_id, requested_model FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.requested_model).toBe(groqModelId);
    expect(row.model_id).toBe(groqModelId); // pin honored
  });

  it.each([['auto'], [undefined]])('logs NULL requested_model for auto routing (model: %s)', async (model) => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      ...(model ? { model } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);

    const row = getDb().prepare('SELECT requested_model FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.requested_model).toBeNull();
  });
});

// Strict pinning: when the client names a model (model: "platform/model_id")
// the proxy must use ONLY that model. A transient error on the pinned model
// must NOT silently fall through to a different model in the chain — that
// would serve a response from a model the user did not pick, which is the
// exact behaviour strict pinning is supposed to prevent. The proxy already
// supports this contract (pinMode: true in routeRequest, PINNED_MODEL_EXHAUSTED
// when all keys burn out); these tests cover the proxy-level integration.
describe('strict pinning (no silent fallback on pinned-model errors)', () => {
  let app: Express;
  let pinnedModelId: number;
  let pinnedDisplayName: string;
  let pinnedModelName: string;
  let fallbackModelId: number;
  let fallbackDisplayName: string;
  let fallbackModelName: string;
  let fallbackPlatform: string;
  let pinnedPlatform: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    // Pick two enabled models on different platforms with different provider
    // fetches so the test can verify the pinned model is hit and the fallback
    // model is NOT hit.
    const db = getDb();
    const enabled = db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name, fc.priority
      FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.enabled = 1 AND fc.enabled = 1
      ORDER BY fc.priority ASC
    `).all() as Array<{ id: number; platform: string; model_id: string; display_name: string; priority: number }>;

    // Pick a high-priority row and a low-priority row on different platforms
    // so the test can assert the proxy tries the pinned one first and stops
    // there.
    pinnedModelId = enabled[0].id;
    pinnedPlatform = enabled[0].platform;
    pinnedModelName = enabled[0].model_id;
    pinnedDisplayName = enabled[0].display_name;

    const otherPlatform = enabled.find(r => r.platform !== pinnedPlatform);
    if (!otherPlatform) throw new Error('Need at least two platforms in the seed catalog');
    fallbackModelId = otherPlatform.id;
    fallbackPlatform = otherPlatform.platform;
    fallbackModelName = otherPlatform.model_id;
    fallbackDisplayName = otherPlatform.display_name;
  });

  beforeEach(async () => {
    setGlobalRetryLimit(5);
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    // Add a key for the pinned platform only — the fallback platform has NO
    // key, so the only way it could "succeed" is if the proxy fell through.
    const addKey = await request(app, 'POST', '/api/keys', {
      platform: pinnedPlatform,
      key: 'pinned-strict-test-key',
      label: 'pinned-strict',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT fall through to a different model when the pinned model returns an in-band error', async () => {
    // Mock fetch: the pinned platform returns an in-band error frame inside a
    // 200 SSE stream (the dead-turn class the proxy normally treats as "skip
    // this model and try the next one in the chain"). With strict pinning,
    // the proxy must NOT fall through — it should report a 502 with the
    // pinned model's name in the error, and no requests should hit the
    // fallback platform.
    const origFetch = global.fetch;
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);
      if (urlStr.includes(fallbackPlatform)) {
        // If the proxy falls through, this branch is hit. The mock returns
        // a normal success so a fallthrough would visibly succeed and
        // contaminate the test. We track via calls[] to assert it never ran.
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-fb', object: 'chat.completion', created: 1,
            model: fallbackModelName,
            choices: [{ index: 0, message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      if (urlStr.includes(pinnedPlatform)) {
        // Pinned platform: simulate an in-band error frame inside the SSE
        // stream. The provider returns 200 + a stream whose first frame is
        // an error chunk, which the proxy classifies as a retryable
        // "in-band provider error" — and the bug was that this triggered a
        // skipModels.add(pinned) + fall through. We assert the fix.
        return {
          ok: true,
          body: makeInBandErrorStream(pinnedDisplayName),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: `${pinnedPlatform}/${pinnedModelName}`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, authHeaders());

    // Strict pinning must surface the in-band error to the user, not fall
    // through. The proxy returns a 502 with the pinned model's name.
    expect(status).toBe(502);
    expect(body?.error?.message).toMatch(new RegExp(pinnedDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // The fallback platform's fetch URL must NOT appear in the call log.
    const fbHits = calls.filter(u => u.includes(fallbackPlatform));
    expect(fbHits).toEqual([]);
  });

  it('returns 429 after exhausting all keys on the pinned model on 403/404 (no model switch)', async () => {
    // Add a second key on the pinned platform so we can test key cycling:
    // PER_KEY_RETRIES=3 attempts on key 1 → markExhausted → key 2 → 3 attempts
    // → markExhausted → 1-RPM recovery. The global retry limit (5) bounds the
    // loop: 3 attempts on key 1 + 2 on key 2 = 5 upstream attempts, then the
    // bound at proxy.ts:844 fires and the response returns 429.
    const addKey2 = await request(app, 'POST', '/api/keys', {
      platform: pinnedPlatform,
      key: 'pinned-strict-test-key-2',
      label: 'pinned-strict-2',
    });
    expect(addKey2.status).toBe(201);

    const origFetch = global.fetch;
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);
      if (urlStr.includes(fallbackPlatform)) {
        // Must NOT be reached — strict pinning must not fall through.
        return { ok: true, json: () => Promise.resolve({ id: 'x', choices: [{ message: { role: 'assistant', content: 'fb' }, finish_reason: 'stop' }] }) } as any;
      }
      if (urlStr.includes(pinnedPlatform)) {
        // Provider returns 403 (model not on this key's tier) for every key.
        // The proxy classifies this as retryable, so it cycles through all
        // keys for the same model and returns 429 once the global recovery
        // limit is hit.
        return { ok: false, status: 403, statusText: 'Forbidden', text: () => Promise.resolve('forbidden'), json: () => Promise.resolve({ error: { message: 'Model not available on your plan' } }) } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: `${pinnedPlatform}/${pinnedModelName}`,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    // Both keys on the pinned platform were tried (3 attempts each = 6 calls).
    // The bound at proxy.ts:844 fires at the start of the next outer iteration
    // once upstreamAttempts >= globalRetryMax (5), so 6 calls fit in before the
    // 429 response is emitted.
    const pinnedCalls = calls.filter(u => u.includes(pinnedPlatform));
    expect(pinnedCalls.length).toBe(6);
    // Fallback was never reached.
    const fbHits = calls.filter(u => u.includes(fallbackPlatform));
    expect(fbHits).toEqual([]);
    // Final response: 429 (recovery limit reached), no model_not_found / model_forbidden.
    expect(status).toBe(429);
    expect(headers['x-upstream-attempts']).toBe('6');
    expect(body?.error?.type).toBe('rate_limit_error');
    expect(body?.error?.code).not.toBe('model_not_found');
    expect(body?.error?.code).not.toBe('model_forbidden');
  });


  it('publishes routing.key_switch when the proxy rotates to a sibling key on the same model (#256)', async () => {
    // Live-terminal feedback gap: the proxy used to publish routing.key_retry
    // (same key) and routing.key_exhausted (key burnt out), but there was
    // NO event for the moment of rotation to a sibling key. Users had to
    // infer the rotation from a gap between the exhaust event on key A and
    // the next retry event on key B. The new routing.key_switch event
    // surfaces the rotation explicitly so the live terminal can show
    // "rotating key #A → #B" at the moment it happens.
    const addKey2 = await request(app, 'POST', '/api/keys', {
      platform: pinnedPlatform,
      key: 'pinned-keyswitch-test-key-2',
      label: 'pinned-keyswitch-2',
    });
    expect(addKey2.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes(fallbackPlatform)) {
        return { ok: true, json: () => Promise.resolve({ id: 'x', choices: [{ message: { role: 'assistant', content: 'fb' }, finish_reason: 'stop' }] }) } as any;
      }
      if (urlStr.includes(pinnedPlatform)) {
        return { ok: false, status: 429, statusText: 'Too Many Requests', text: () => Promise.resolve('rate limited'), json: () => Promise.resolve({ error: { message: 'rate limit exceeded' } }) } as any;
      }
      return origFetch(url, init);
    });

    // Subscribe to the in-process event bus BEFORE the request fires so we
    // capture the key_switch event when the proxy rotates from key 1 to key 2.
    const { subscribe } = await import('../../services/events.js');
    const events: any[] = [];
    const unsub = subscribe((e) => events.push(e));
    try {
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        model: `${pinnedPlatform}/${pinnedModelName}`,
        messages: [{ role: 'user', content: 'hi' }],
      }, authHeaders());
      expect(status).toBe(429);
    } finally {
      unsub();
    }

    // Find the key_switch event(s) emitted by this request. There must be
    // at least one — the proxy rotated from the first pinned key to the
    // second when the first exhausts.
    const switchEvents = events.filter(e => e.type === 'routing.key_switch');
    expect(switchEvents.length).toBeGreaterThanOrEqual(1);
    const sw = switchEvents[0];
    expect(sw.provider).toBe(pinnedPlatform);
    expect(sw.model).toBe(pinnedModelName);
    expect(typeof sw.fromKeyId).toBe('number');
    expect(typeof sw.toKeyId).toBe('number');
    expect(sw.fromKeyId).not.toBe(sw.toKeyId);
  });
  it('cycles through ALL keys for a pinned model when every key is on cooldown (#256)', { timeout: 15000 }, async () => {
    // Reproduces the user's nvidia scenario: every key for the pinned model
    // is on cooldown, so the router's pre-filter would normally reject them
    // all and throw PINNED_MODEL_EXHAUSTED before the proxy ever calls the
    // provider. The fix adds a pinned-model fallback that returns the first
    // available key anyway, so the proxy can attempt the call, run its
    // 3-retry cycle, exhaust the key, and move to the next one. Without
    // this, a pinned model with cooled-down keys surfaces as
    // "Recovery cycle N/∞" forever with zero upstream calls per cycle.
    const addKey2 = await request(app, 'POST', '/api/keys', {
      platform: pinnedPlatform,
      key: 'pinned-cooldown-test-key-2',
      label: 'pinned-cooldown-2',
    });
    expect(addKey2.status).toBe(201);

    // Force BOTH keys onto cooldown so the pre-filter rejects them. The
    // pinned-model fallback in router.ts should still return a key so the
    // proxy can attempt the call.
    const { setCooldown } = await import('../../services/ratelimit.js');
    const db = getDb();
    const pinnedKeys = db.prepare(
      "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1"
    ).all(pinnedPlatform) as Array<{ id: number }>;
    expect(pinnedKeys.length).toBe(2);
    for (const k of pinnedKeys) {
      setCooldown(pinnedPlatform, pinnedModelName, k.id, 60_000);
    }

    const origFetch = global.fetch;
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);
      if (urlStr.includes(fallbackPlatform)) {
        // Must NOT be reached — strict pinning must not fall through.
        return { ok: true, json: () => Promise.resolve({ id: 'x', choices: [{ message: { role: 'assistant', content: 'fb' }, finish_reason: 'stop' }] }) } as any;
      }
      if (urlStr.includes(pinnedPlatform)) {
        // Provider returns 429 — the proxy's normal retryable path. Even
        // though the key is on cooldown, the pinned-model fallback returns
        // a key and the proxy attempts the call anyway.
        return { ok: false, status: 429, statusText: 'Too Many Requests', text: () => Promise.resolve('rate limited'), json: () => Promise.resolve({ error: { message: 'rate limit exceeded' } }) } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: `${pinnedPlatform}/${pinnedModelName}`,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    // Both keys were tried (3 attempts each = 6 upstream calls). Without
    // the pinned-model fallback the router would have thrown
    // PINNED_MODEL_EXHAUSTED on the very first call and zero upstream
    // calls would have been made.
    const pinnedCalls = calls.filter(u => u.includes(pinnedPlatform));
    expect(pinnedCalls.length).toBe(6);
    // Fallback was never reached.
    const fbHits = calls.filter(u => u.includes(fallbackPlatform));
    expect(fbHits).toEqual([]);
    // Final response: 429 (recovery limit reached).
    expect(status).toBe(429);
    expect(body?.error?.type).toBe('rate_limit_error');
  });
});

;

// Build a minimal ReadableStream that yields an in-band error frame, then
// closes. Matches the upstream provider format the proxy's stream reader
// expects (data: {"error":{...}}\n\n followed by a clean close).
function makeInBandErrorStream(displayName: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frame = `data: ${JSON.stringify({ error: { message: `Internal server error from ${displayName}` } })}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
}
