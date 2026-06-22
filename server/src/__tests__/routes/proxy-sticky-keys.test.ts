import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
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

// Integration test: a custom provider has sticky_sessions_enabled=1, two
// keys are configured. A 2-turn conversation should hit the SAME key on
// both turns (sticky selection via sha1(sessionKey) % keyCount). Without
// sticky, the router would round-robin or hash to a different key on turn 2.
describe('sticky-keys routing (per-key session isolation)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    // FK-safe delete order.
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM custom_providers').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hits the same key on turn 1 and turn 2 when sticky_sessions_enabled=1', async () => {
    const db = getDb();

    // Create the custom provider with sticky enabled. Use the API so the
    // schema is respected; syncModelsFromProvider is gated under VITEST.
    const prov = await request(app, 'POST', '/api/custom-providers', {
      slug: 'stickyprov',
      displayName: 'Sticky Prov',
      baseUrl: 'https://stickyprov.example/v1',
      rpmLimit: 600,
      apiFormat: 'openai',
      stickySessionsEnabled: true,
    });
    expect(prov.status).toBe(201);

    // Manually flip the sticky flag if the test runner isn't using the
    // PATCH path above. Direct UPDATE ensures the column is 1 even if the
    // POST handler skipped it for any reason.
    db.prepare('UPDATE custom_providers SET sticky_sessions_enabled = 1 WHERE slug = ?')
      .run('stickyprov');

    // Add two API keys via the API (handles encryption).
    const k1 = await request(app, 'POST', '/api/keys', {
      platform: 'stickyprov',
      key: 'sk-test-key-1',
      label: 'key-1',
    });
    expect(k1.status).toBe(201);
    const k2 = await request(app, 'POST', '/api/keys', {
      platform: 'stickyprov',
      key: 'sk-test-key-2',
      label: 'key-2',
    });
    expect(k2.status).toBe(201);

    // Seed a model on the custom provider with all required NOT-NULL columns.
    db.prepare(
      `INSERT INTO models
       (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, monthly_token_budget, context_window, enabled,
        supports_vision, supports_tools, max_output_tokens)
       VALUES ('stickyprov', 'sticky-model', 'Sticky Model', 10, 10,
               'Medium', '~100K', 128000, 1, 0, 1, 8192)`,
    ).run();
    const modelRow = db.prepare(
      `SELECT id FROM models WHERE platform = 'stickyprov' AND model_id = 'sticky-model'`,
    ).get() as { id: number };
    db.prepare(
      `INSERT INTO fallback_config (model_db_id, priority, enabled)
       VALUES (?, 1, 1)`,
    ).run(modelRow.id);

    // Track which key was used per upstream call. The router forwards
    // the key via Authorization header on the upstream fetch.
    const callsByKey = new Map<string, number>();
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const apiKey = headers['authorization'] ?? headers['Authorization'] ?? 'unknown';
      callsByKey.set(apiKey, (callsByKey.get(apiKey) ?? 0) + 1);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: () => Promise.resolve(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'sticky-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'reply' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
        ),
        json: () => Promise.resolve({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'sticky-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'reply' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      } as Response;
    });

    // Turn 1: a single user message; sticky cache key derived from
    // sessionKey + apiKey.
    const turn1 = await request(app, 'POST', '/v1/chat/completions', {
      model: 'stickyprov/sticky-model',
      messages: [{ role: 'user', content: 'hello world' }],
    }, authHeaders());
    expect(turn1.status).toBe(200);

    // Turn 2: same conversation continues with an assistant turn appended,
    // so getStickyModel returns the model pinned on turn 1, AND
    // routeRequest selects the same key via sha1(sessionKey) % 2.
    const turn2 = await request(app, 'POST', '/v1/chat/completions', {
      model: 'stickyprov/sticky-model',
      messages: [
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second turn' },
      ],
    }, authHeaders());
    expect(turn2.status).toBe(200);

    // Sticky assertion: with sha1 deterministic, the SAME session key
    // hashes to the same key index for both turns. So both turns must hit
    // the same key — only 1 distinct key observed across all upstream
    // calls (excluding PER_KEY_RETRIES retries).
    const distinctKeys = callsByKey.size;
    expect(distinctKeys).toBe(1);
  });
});