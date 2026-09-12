import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
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

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Virtual "auto" model', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_auto_model_test',
      label: 'auto-model',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists "auto" as the first /v1/models entry', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data[0]).toMatchObject({
      id: 'auto',
      object: 'model',
      owned_by: 'api-gateway',
    });
    // Real catalog models still follow.
    expect(body.data.length).toBeGreaterThan(1);
  });

  it('fails when authentication is missing or wrong', async () => {
    const { status: status1 } = await request(app, 'GET', '/v1/models');
    expect(status1).toBe(401);

    const { status: status2 } = await request(app, 'GET', '/v1/models', undefined, { Authorization: 'Bearer wrongkey' });
    expect(status2).toBe(401);
  });

  it('returns unique model ids from /v1/models', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);

    const ids = body.data.map((model: { id: string }) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes OpenAI-completions-compatible capabilities on /v1/models entries', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);

    // Strict OpenAI list envelope still parses cleanly (Hermes, openai-python).
    expect(body.object).toBe('list');
    for (const entry of body.data) {
      expect(entry.object).toBe('model');
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.owned_by).toBe('string');
    }

    // Extension fields are additive — every non-AUTO row must carry them.
    const sampleEntry = body.data.find(
      (m: { id: string }) => m.id !== 'auto' && typeof m.capabilities === 'object',
    );
    expect(sampleEntry).toBeDefined();
    expect(sampleEntry.capabilities).toMatchObject({
      // Streaming + json_mode are universal for our chat-completions adapter.
      streaming: true,
      json_mode: true,
      // tool_calls/vision/reasoning keys present (boolean) so strict consumers
      // can read them without undefined checks.
    });
    expect(typeof sampleEntry.capabilities.tool_calls).toBe('boolean');
    expect(typeof sampleEntry.capabilities.vision).toBe('boolean');
    expect(typeof sampleEntry.capabilities.reasoning).toBe('boolean');

    // Modalities are arrays; per-model input is text-only when vision=0,
    // text+image when vision=1.
    expect(Array.isArray(sampleEntry.modalities.input)).toBe(true);
    expect(sampleEntry.modalities.input).toContain('text');
    if (sampleEntry.capabilities.vision) {
      expect(sampleEntry.modalities.input).toContain('image');
    }
    expect(sampleEntry.modalities.output).toEqual(['text']);

    // Token caps are surfaced: context_window on the row, max_tokens alongside.
    expect('context_window' in sampleEntry || sampleEntry.context_window === null || typeof sampleEntry.context_window === 'number').toBe(true);
    expect('max_tokens' in sampleEntry).toBe(true);
    const maxTokens = sampleEntry.max_tokens;
    expect(maxTokens === null || typeof maxTokens === 'number').toBe(true);

    // Reasoning detector: families explicitly patterned in `buildModelCapabilities`
    // must surface reasoning=true; non-reasoning families must surface false.
    const reasoningOnFamily = body.data.find(
      (m: { id: string; capabilities?: { reasoning?: boolean } }) =>
        /\/.*(deepseek-r1|kimi-k2-thinking|minimax-m3|qwq-|magistral|gpt-oss|reasoning)/.test(m.id),
    );
    if (reasoningOnFamily) {
      expect(reasoningOnFamily.capabilities.reasoning).toBe(true);
    }
    // MiniMax M2.7 via NVIDIA (`minimaxai/minimax-m2.7`) is a thinking-tier
    // model but its id did NOT match the old `minimax-m3`/`minimax-m2.5`
    // patterns, so /models advertised reasoning:false and the client never
    // enabled thinking. The broadened pattern must surface reasoning=true.
    // (#292)
    const minimaxM27 = body.data.find(
      (m: { id: string }) => m.id === 'nvidia/minimaxai/minimax-m2.7',
    );
    if (minimaxM27) {
      expect(minimaxM27.capabilities.reasoning).toBe(true);
    }
    // MiniMax M3 via NVIDIA (`minimaxai/minimax-m3`) is seeded by the V33
    // every-boot migration (it's live on NIM but was missing from the V11
    // catalog). Asserted against the DB directly because /models filters to
    // platforms with a configured key, and this test only adds a groq key.
    // The reasoning capability is verified separately via the pattern in
    // buildModelCapabilities (`minimax-m3` matches the reasoning family).
    // (#292)
    const m3Row = getDb().prepare(
      `SELECT model_id FROM models WHERE platform = 'nvidia' AND model_id = 'minimaxai/minimax-m3' AND enabled = 1`,
    ).get();
    expect(m3Row).toBeDefined();
    // Thinking is data-driven now: every untouched row advertises
    // reasoning=true with the full six-level menu (no id-pattern gating), so
    // the universal contract is a non-empty efforts menu on every model.
    for (const entry of body.data) {
      if (entry.id === 'auto') continue;
      expect(entry.capabilities.reasoning).toBe(true);
      expect(Array.isArray(entry.capabilities.reasoning_efforts)).toBe(true);
      expect(entry.capabilities.reasoning_efforts.length).toBeGreaterThan(0);
    }
  });

  it('advertises per-model reasoning_efforts on /v1/models capabilities', async () => {
    const db = getDb();
    const seed = (modelId: string, levelsJson: string | null) => {
      db.prepare(
        `INSERT INTO models
         (platform, model_id, display_name, intelligence_rank, speed_rank,
          size_label, monthly_token_budget, context_window, enabled,
          supports_vision, max_output_tokens${levelsJson === null ? '' : ', thinking_levels'})
         VALUES ('groq', ?, ?, 10, 10, 'Medium', '~100K', 128000, 1, 0, 8192${levelsJson === null ? '' : ', ?'})`,
      ).run(...(levelsJson === null ? [modelId, modelId] : [modelId, modelId, levelsJson]));
      const row = db.prepare(
        `SELECT id FROM models WHERE platform = 'groq' AND model_id = ?`,
      ).get(modelId) as { id: number };
      db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)`).run(row.id);
    };
    // Restricted menu survives advertisement verbatim…
    seed('advrestricted', '["low","high","max"]');
    // …NULL column defaults to thinking ENABLED with the full scale —
    // advertisement is purely data-driven, no id-pattern matching…
    seed('advopen', null);
    seed('plainchat-advdefault', null);
    // …and an explicit off force-disables: reasoning=false, no menu.
    seed('advoff', '["off"]');

    try {
      const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
      expect(status).toBe(200);

      const restricted = body.data.find((m: { id: string }) => m.id === 'groq/advrestricted');
      expect(restricted).toBeDefined();
      expect(restricted.capabilities.reasoning).toBe(true);
      expect(restricted.capabilities.reasoning_efforts).toEqual(['low', 'high', 'max']);

      for (const id of ['groq/advopen', 'groq/plainchat-advdefault']) {
        const entry = body.data.find((m: { id: string }) => m.id === id);
        expect(entry).toBeDefined();
        expect(entry.capabilities.reasoning).toBe(true);
        expect(entry.capabilities.reasoning_efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
      }

      const off = body.data.find((m: { id: string }) => m.id === 'groq/advoff');
      expect(off).toBeDefined();
      expect(off.capabilities.reasoning).toBe(false);
      expect(off.capabilities.reasoning_efforts).toBeUndefined();
    } finally {
      db.prepare(
        `DELETE FROM fallback_config WHERE model_db_id IN (
           SELECT id FROM models WHERE platform = 'groq'
             AND model_id IN ('advrestricted', 'advopen', 'plainchat-advdefault', 'advoff'))`,
      ).run();
      db.prepare(
        `DELETE FROM models WHERE platform = 'groq'
           AND model_id IN ('advrestricted', 'advopen', 'plainchat-advdefault', 'advoff')`,
      ).run();
    }
  });

  it('treats model:"auto" as auto-route instead of a 400', async () => {
    const origFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'routed via auto' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('routed via auto');
  });

  it('still rejects an unknown model with model_not_found', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
  });
});

describe('Pinned model resolution (strict <platform>/<model_id>)', () => {
  // PINNING CONTRACT (strict): the ONLY accepted pin form is
  // `<platform>/<model_id>`, after stripping at most one `api-gateway/`
  // extension envelope. A bare id (even a unique one), an empty segment, or a
  // vendor-namespace prefix is a hard 400 — not partially, not gracefully.
  // There is no `ambiguous` verdict anymore: the pair lookup is exact.
  let app: Express;

  beforeAll(() => {
    // Sibling describe (NOT nested in the "Virtual auto model" describe), so
    // it needs its own DB + app + dashboard token.
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    // Seed fixtures across groq + nvidia (both have registered providers, so
    // a resolved pin can actually reach upstream). Each fixture also joins
    // fallback_config — the router only ever routes chain members, so a pin
    // whose model is outside the chain would fall through to the chain head.
    //   (1) `baremod` — a bare id shared across both platforms. As a pin it is
    //       malformed (no slash) and rejected before any platform question.
    //   (2) `uniqueid` — a bare id served by exactly ONE platform. Still
    //       rejected: the strict contract has no shorthand, unique or not.
    //   (3) `MiniMax-M3/slashmod` — a slash-bearing id whose first segment is
    //       a vendor namespace fragment, NOT a platform. Pinning it verbatim
    //       is not_found; pinning `nvidia/MiniMax-M3/slashmod` (first-slash
    //       split) resolves.
    const db = getDb();
    const insertModel = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
       VALUES (?, ?, ?, 5, 5, '', 1)`,
    );
    const insertFallback = db.prepare(
      'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
    );
    const seed = (platform: string, modelId: string, label: string) => {
      const id = Number(insertModel.run(platform, modelId, label).lastInsertRowid);
      insertFallback.run(id, 900 + id); // behind the seeded catalog, spliced on pin
    };
    seed('groq', 'baremod', 'Bare G');
    seed('nvidia', 'baremod', 'Bare N');
    seed('groq', 'uniqueid', 'Unique G');
    seed('groq', 'MiniMax-M3/slashmod', 'Slash G');
    seed('nvidia', 'MiniMax-M3/slashmod', 'Slash N');
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    // Add a groq key so the platform-prefixed pin can route to upstream.
    // groq is a built-in provider, so POST /api/keys accepts it.
    const add = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'gsk_pinned_resolution_test', label: 'pin-res' });
    expect(add.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a bare pin that names a unique model (400 — no shorthand)', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'uniqueid',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain("does not match the required '<platform>/<model_id>' form");
    expect(body.error.message).toContain('/v1/models');
  });

  it('rejects a bare pin shared across platforms without enumerating them', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'baremod',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    // Malformed-form rejection: the fix is the FORM, so naming candidate
    // platforms would mislead.
    expect(body.error.message).toContain("does not match the required '<platform>/<model_id>' form");
    expect(body.error.message).not.toContain('nvidia');
  });

  it('rejects a vendor-namespace pin (first segment is not a platform)', async () => {
    // `MiniMax-M3/slashmod` splits at the first slash into platform
    // `MiniMax-M3` + id `slashmod` — no such row exists, and there is no
    // bare-id fallback, so the pin is simply not in the catalog.
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'MiniMax-M3/slashmod',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('is not in the catalog');
  });

  it('resolves the canonical form and reaches upstream', async () => {
    const origFetch = global.fetch;
    let calledGroq = false;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // The router calls groq's upstream for the `groq/baremod` pin.
      if (urlStr.includes('api.groq.com')) {
        calledGroq = true;
        return new Response(JSON.stringify({
          id: 'chatcmpl-pin',
          object: 'chat.completion',
          created: 1,
          model: 'groq/baremod',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'routed via pinned groq' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url as unknown as RequestInfo, init as unknown as RequestInit);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/baremod',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(200);
    expect(calledGroq).toBe(true);
    expect(body.choices[0].message.content).toBe('routed via pinned groq');
  });

  it('resolves a multi-slash model id via the FIRST slash', async () => {
    // `nvidia/MiniMax-M3/slashmod` → platform `nvidia`, id `MiniMax-M3/slashmod`.
    // The key is the one on the pinned (nvidia) platform, and X-Routed-Via
    // proves the resolver kept the model id intact rather than truncating it.
    const addNv = await request(app, 'POST', '/api/keys', {
      platform: 'nvidia',
      key: 'nvapi_pinned_slashmod_test',
      label: 'pin-res-nv',
    });
    expect(addNv.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('127.0.0.1')) return origFetch(url as unknown as RequestInfo, init as unknown as RequestInit);
      return new Response(JSON.stringify({
        id: 'chatcmpl-pin-nv',
        object: 'chat.completion',
        created: 1,
        model: 'MiniMax-M3/slashmod',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'routed via pinned nvidia' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'nvidia/MiniMax-M3/slashmod',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe('nvidia/MiniMax-M3/slashmod');
    expect(body.choices[0].message.content).toBe('routed via pinned nvidia');
  });

  it('strips the api-gateway/ envelope and resolves the canonical remainder (OMP form)', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          id: 'chatcmpl-env',
          object: 'chat.completion',
          created: 1,
          model: 'groq/baremod',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'routed via envelope' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url as unknown as RequestInfo, init as unknown as RequestInit);
    });

    const { status, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'api-gateway/groq/baremod',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe('groq/baremod');
  });

  it('rejects the api-gateway/ envelope over a bare remainder', async () => {
    // One strip leaves `baremod`, which is not `<platform>/<model_id>`.
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'api-gateway/baremod',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain("does not match the required '<platform>/<model_id>' form");
  });
});

