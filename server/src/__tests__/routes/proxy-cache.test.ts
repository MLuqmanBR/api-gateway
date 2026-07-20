import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// F5: Response cache integration test — verifies a temp-0 request is served
// from the cache on the second call (X-Cache: HIT) and bypassed with no_cache.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as unknown as Record<string, unknown>;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy, setGlobalRetryLimit } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { purgeCache } from '../../services/cache.js';

let dashToken = '';

async function req(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data, headers: res.headers };
}

const assistantResponse = {
  id: 'test-cmpl',
  object: 'chat.completion',
  model: 'groq/test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Cached!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('Response cache in proxy (F5)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.TRUST_PROXY = '1';
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    key = getUnifiedApiKey();

    setSetting('cache_enabled', 'true');
    setSetting('cache_ttl_seconds', '86400');

    const db = getDb();
    setRoutingStrategy('priority');
    setGlobalRetryLimit(0);
    const k1 = encrypt('the-only-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'only', ?, ?, ?, 'healthy', 1)
    `).run(k1.encrypted, k1.iv, k1.authTag);
    db.prepare(`
      UPDATE fallback_config SET enabled = 0
      WHERE model_db_id NOT IN (
        SELECT id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();
    db.prepare(`
      UPDATE api_keys SET enabled = 0 WHERE id NOT IN (
        SELECT id FROM api_keys WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();

    chatCompletion.mockImplementation(async () => assistantResponse);
  });

  beforeEach(() => {
    chatCompletion.mockClear();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    purgeCache();
    setSetting('cache_enabled', 'true');
  });

  async function postChat(body: any = {}, headers: Record<string, string> = {}) {
    return req(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Format this JSON' }],
      temperature: 0,
      stream: false,
      ...body,
    }, { Authorization: `Bearer ${key}`, ...headers });
  }

  it('first call misses cache (X-Cache: MISS), provider is called', async () => {
    const res = await postChat();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('second identical call hits cache (X-Cache: HIT), provider NOT called', async () => {
    await postChat(); // fill cache
    chatCompletion.mockClear();
    const res = await postChat();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('temperature > 0 is not cached (no X-Cache header, provider called twice)', async () => {
    await postChat({ temperature: 0.7 });
    chatCompletion.mockClear();
    const res = await postChat({ temperature: 0.7 });
    expect(res.headers.get('x-cache')).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('cache:{no_cache:true} bypasses the cache (no X-Cache header)', async () => {
    await postChat(); // fill cache
    chatCompletion.mockClear();
    const res = await postChat({ cache: { no_cache: true } });
    expect(res.headers.get('x-cache')).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('X-API-Gateway-No-Cache header bypasses the cache (no X-Cache header)', async () => {
  await postChat(); // fill cache
  chatCompletion.mockClear();
     const res = await postChat({}, { 'X-API-Gateway-No-Cache': '1' });
  expect(res.headers.get('x-cache')).toBeNull();
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('different messages produce different cache entries', async () => {
    await postChat({ messages: [{ role: 'user', content: 'A' }] });
    await postChat({ messages: [{ role: 'user', content: 'B' }] });
    chatCompletion.mockClear();
    // First message should be cached
    const res1 = await postChat({ messages: [{ role: 'user', content: 'A' }] });
    expect(res1.headers.get('x-cache')).toBe('HIT');
    // Second message should also be cached
    const res2 = await postChat({ messages: [{ role: 'user', content: 'B' }] });
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('cache disabled via setting → no X-Cache header, provider always called', async () => {
    setSetting('cache_enabled', 'false');
    await postChat();
    chatCompletion.mockClear();
    const res = await postChat();
    expect(res.headers.get('x-cache')).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    setSetting('cache_enabled', 'true');
  });
});
