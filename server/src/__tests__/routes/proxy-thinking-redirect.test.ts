import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers)
        ? { Authorization: `Bearer ${dashToken}` }
        : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  server.close();
  let json: unknown = null;
  try {
    json = JSON.parse(data);
  } catch {
    /* non-JSON body, leave json null */
  }
  return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// Integration test: the proxy redirects a client-requested effort level to
// the model's supported set (`models.thinking_levels`) per attempt — the
// OUTBOUND provider body carries the redirected level, not the raw request.
// The platform here is NOT a GLM host, so the openai-compat layer forwards
// effort verbatim; every difference observed is attributable to the redirect.
describe('per-model thinking-level redirect in the proxy', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM custom_providers').run();
  });

  async function seedModel(modelId: string, levelsJson: string | null): Promise<void> {
    const db = getDb();
    const prov = await request(app, 'POST', '/api/custom-providers', {
      slug: 'thinkprov',
      displayName: 'Think Prov',
      baseUrl: 'https://thinkprov.example/v1',
      apiFormat: 'openai',
    });
    if (prov.status !== 201 && prov.status !== 409) throw new Error(`provider seed failed: ${JSON.stringify(prov.body)}`);
    await request(app, 'POST', '/api/keys', { platform: 'thinkprov', key: 'sk-test-key', label: 'k1' });
    db.prepare(
      `INSERT INTO models
       (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, monthly_token_budget, context_window, enabled,
        supports_vision, max_output_tokens${levelsJson === null ? '' : ', thinking_levels'})
       VALUES ('thinkprov', ?, ?, 10, 10, 'Medium', '~100K', 128000, 1, 0, 8192${levelsJson === null ? '' : ', ?'})`,
    ).run(...(levelsJson === null ? [modelId, modelId] : [modelId, modelId, levelsJson]));
    const row = db.prepare(
      `SELECT id FROM models WHERE platform = 'thinkprov' AND model_id = ?`,
    ).get(modelId) as { id: number };
    db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)`).run(row.id);
  }

  function captureOutboundBody(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    // Intercept ONLY provider-bound calls; the test client itself talks to
    // the express app over loopback fetch and must fall through untouched.
    const realFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('thinkprov.example')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            id: 'chatcmpl-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'reply' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          })),
          json: () => Promise.resolve({
            id: 'chatcmpl-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'reply' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        } as Response;
      }
      return realFetch(url as Parameters<typeof realFetch>[0], init);
    });
    return { bodies };
  }
  it('redirects xhigh → high and minimal → low against a low|medium|high-only model', async () => {
    await seedModel('narrow-model', '["low","medium","high"]');
    const { bodies } = captureOutboundBody();

    const xhigh = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/narrow-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    }, authHeaders());
    expect(xhigh.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBe('high');

    const minimal = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/narrow-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'minimal',
    }, authHeaders());
    expect(minimal.status).toBe(200);
    expect(bodies[1].reasoning_effort).toBe('low');
  });

  it('passes an already-enabled level through untouched', async () => {
    await seedModel('narrow-model', '["low","medium","high"]');
    const { bodies } = captureOutboundBody();
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/narrow-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
    }, authHeaders());
    expect(res.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBe('medium');
  });

  it('forwards any level verbatim when the model has the unrestricted default', async () => {
    await seedModel('wide-model', '["minimal","low","medium","high","xhigh","max"]');
    const { bodies } = captureOutboundBody();
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/wide-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'max',
    }, authHeaders());
    expect(res.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBe('max');
  });

  it('sends no effort fields when the client requested none (auto passthrough)', async () => {
    await seedModel('narrow-model', '["low","medium","high"]');
    const { bodies } = captureOutboundBody();
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/narrow-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(res.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[0].thinking).toBeUndefined();
  });

  it('rejects effort-bearing requests with 400 on a force-off model, forwards clean requests', async () => {
    await seedModel('off-model', '["off"]');

    const rejected = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/off-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'low',
    }, authHeaders());
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/thinking disabled/i);

    // A thinking object without an effort (Anthropic-style budget carrier) is
    // still a thinking attempt — same rejection.
    const objRejected = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/off-model',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget: 4000 },
    }, authHeaders());
    expect(objRejected.status).toBe(400);

    // No thinking surface → the request proceeds normally.
    const { bodies } = captureOutboundBody();
    const ok = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/off-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(ok.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBeUndefined();
  });

  it('accepts client reasoning_effort:off as an explicit disable and forwards no thinking fields', async () => {
    await seedModel('levels-model', '["low","high","max"]');
    const { bodies } = captureOutboundBody();

    const off = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/levels-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }, authHeaders());
    expect(off.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[0].thinking).toBeUndefined();
  });

  it('lets an explicit {type:disabled} request through a force-off model', async () => {
    await seedModel('off-model-2', '["off"]');
    const { bodies } = captureOutboundBody();

    const ok = await request(app, 'POST', '/v1/chat/completions', {
      model: 'thinkprov/off-model-2',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
    }, authHeaders());
    expect(ok.status).toBe(200);
    expect(bodies[0].reasoning_effort).toBeUndefined();
  });

  it('canonicalizes mixed off input to [off] alone and flags the row manual', async () => {
    await seedModel('offwrite', null);
    const row = getDb().prepare(
      `SELECT id FROM models WHERE platform = 'thinkprov' AND model_id = 'offwrite'`,
    ).get() as { id: number };

    const patched = await request(app, 'PATCH', `/api/custom-models/${row.id}`, {
      thinkingLevels: ['off', 'low'],
    });
    expect(patched.status).toBe(200);

    const stored = getDb().prepare(
      `SELECT thinking_levels, thinking_levels_manual FROM models WHERE id = ?`,
    ).get(row.id) as { thinking_levels: string; thinking_levels_manual: number };
    expect(JSON.parse(stored.thinking_levels)).toEqual(['off']);
    expect(stored.thinking_levels_manual).toBe(1);

    // Dashboard-facing reads normalize identically.
    const listed = await request(app, 'GET', '/api/custom-providers/thinkprov/models');
    const served = (listed.body ?? []).find?.((m: { model_id?: string }) => m.model_id === 'offwrite');
    if (served) expect(served.thinkingLevels).toEqual(['off']);
  });
});
