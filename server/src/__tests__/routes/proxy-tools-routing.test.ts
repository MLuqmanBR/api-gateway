import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';

interface PostResult {
  status: number;
  body: {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { code?: string; message?: string };
    output_text?: string;
  };
  headers: Record<string, string>;
}

async function post(app: Express, path: string, body: unknown, key: string): Promise<PostResult> {
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no listen address');
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: PostResult['body'] | null = null;
  try { json = JSON.parse(text) as PostResult['body']; } catch {}
  return { status: res.status, body: json ?? {}, headers: Object.fromEntries(res.headers) };
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

const TOOLS_CHAT = {
  messages: [{ role: 'user', content: 'what is the weather in Berlin?' }],
  tools: [WEATHER_TOOL],
};

const TOOLS_RESPONSES = {
  input: 'what is the weather in Berlin?',
  tools: [{
    type: 'function',
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  }],
};

// The supports_tools capability system was REMOVED (2026-08-23): every model
// is treated as tool-capable and the router has no tools filter. Its only
// real-world effect was the bug this suite now guards against — tool-bearing
// requests pinned to a formerly "non-tool" model were silently rerouted to a
// different model (594/594 off-pin responses in the live audit). These tests
// pin the replacement contract: a pinned model ALWAYS serves its own request,
// tool-bearing or not.
describe('tools requests respect strict pinning (supports_tools removed)', () => {
  let app: Express;
  let key: string;
  let pinnedDbId: number;
  let pinnedModelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('priority');
    // big-pickle is seeded by V18 on the opencode platform; historically it
    // carried supports_tools = 0 (stealth/unknown family), i.e. exactly the
    // class of pin the old filter silently abandoned.
    const pin = getDb().prepare(`
      SELECT m.id, m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id AND fc.enabled = 1
      WHERE m.platform = 'opencode' AND m.model_id = 'big-pickle' AND m.enabled = 1
    `).get() as { id: number; model_id: string } | undefined;
    expect(pin).toBeDefined();
    pinnedDbId = pin!.id;
    pinnedModelId = `opencode/${pin!.model_id}`;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    // One healthy key for the pinned platform only — any fallthrough finds no
    // other platform with keys and fails loudly instead of serving off-pin.
    const { encrypted, iv, authTag } = encrypt('test-opencode-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('opencode', 'pin-test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    getDb().prepare('DELETE FROM api_keys').run();
  });

  function mockUpstream(content: string): void {
    const origFetch = global.fetch;
    // NOTE: both args must be forwarded. Dropping `init` turns the client's
    // own POST into a bare GET (Express then 404s the POST-only route).
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('opencode.ai')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-pin-tools', object: 'chat.completion', created: 1, model: pinnedModelId,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as unknown as Response;
      }
      return origFetch(url, init);
    });
  }

  it('router-level: pinMode keeps the route on the pinned model for a tool-bearing request', () => {
    const route = routeRequest(1000, undefined, pinnedDbId, false, undefined, { pinMode: true });
    expect(route.modelDbId).toBe(pinnedDbId);
    expect(`${route.platform}/${route.modelId}`).toBe(pinnedModelId);
  });

  it('route-level: pinned chat completion with tools is served by the pinned model', async () => {
    mockUpstream('sunny');
    const { status, headers, body } = await post(app, '/v1/chat/completions', {
      model: pinnedModelId,
      ...TOOLS_CHAT,
    }, key);
    expect(status).toBe(200);
    expect(body.choices?.[0]?.message?.content).toBe('sunny');
    // X-Routed-Via proves WHICH model answered — the reported bug was this
    // header naming a different platform/model than the pin.
    expect(headers['x-routed-via']).toBe(pinnedModelId);

    const row = getDb().prepare('SELECT requested_model, model_id FROM requests ORDER BY id DESC LIMIT 1').get() as { requested_model: string | null; model_id: string } | undefined;
    expect(row?.requested_model).toBe(pinnedModelId);
    // requests.model_id stores the catalog model_id (no platform prefix);
    // the pin held because it equals the pinned row's id, not a failover target.
    expect(row?.model_id).toBe('big-pickle'); // pin honored end-to-end
  });

  it('route-level: pinned /v1/responses run with tools stays on the pinned model', async () => {
    mockUpstream('raining');
    const { status, headers } = await post(app, '/v1/responses', {
      model: pinnedModelId,
      ...TOOLS_RESPONSES,
    }, key);
    expect(status).toBe(200);
    expect(headers['x-routed-via']).toBe(pinnedModelId);
  });

  it('plain tool-bearing auto request routes normally (no 422 gate anywhere)', async () => {
    mockUpstream('ok');
    const { status, body } = await post(app, '/v1/chat/completions', TOOLS_CHAT, key);
    expect(status).not.toBe(422);
    expect(body.error?.code).toBeUndefined();
    expect(body.choices?.[0]?.message?.content).toBe('ok');
  });
});
