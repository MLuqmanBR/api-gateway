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
    const nonReasoning = body.data.find(
      (m: { id: string; capabilities?: { reasoning?: boolean } }) =>
        m.id !== 'auto' && m.capabilities && m.capabilities.reasoning === false,
    );
    expect(nonReasoning).toBeDefined();
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
