import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// F4: Budget enforcement integration test — verifies the 402 hard-cap fires
// at the proxy level when a client key has an exhausted budget, and that the
// upstream provider is NEVER called (the check runs before dispatch).

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
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy, setGlobalRetryLimit } from '../../services/router.js';
import { mintClientKey } from '../../lib/client-keys.js';
import { setBudget } from '../../services/budgets.js';
async function postChat(app: Express, authKey: string, body: any = {}) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authKey}` },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      stream: false,
      ...body,
    }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Budget enforcement in proxy (F4)', () => {
  let app: Express;
  let clientKeyAuth: string;
  let clientKeyId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();

    const db = getDb();
    setRoutingStrategy('priority');
    setGlobalRetryLimit(0);

    // One key on groq — the mock provider will answer (or not, if budget blocks first).
    const k1 = encrypt('the-only-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'only', ?, ?, ?, 'healthy', 1)
    `).run(k1.encrypted, k1.iv, k1.authTag);
    // Keep only the first groq model enabled; disable every other fallback row
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

    // Mint a client key for budget testing
    const minted = mintClientKey(getDb(), 'budget-test');
    clientKeyId = minted.id;
    clientKeyAuth = minted.key;

    // Mock provider returns a valid non-streaming response
    chatCompletion.mockImplementation(async () => ({
      id: 'test-cmpl',
      object: 'chat.completion',
      model: 'groq/test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });

  beforeEach(() => {
    chatCompletion.mockClear();
    getDb().prepare('DELETE FROM budgets').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('allows requests when no budget is set (backward-compat)', async () => {
    const res = await postChat(app, clientKeyAuth);
    expect(res.status).toBe(200);
    expect(chatCompletion).toHaveBeenCalled();
  });

  it('returns 402 budget_exhausted when daily limit is 0', async () => {
    setBudget('client_key', clientKeyId, { daily_limit_cents: 0 });
    const res = await postChat(app, clientKeyAuth);
    expect(res.status).toBe(402);
    expect(res.body.error.type).toBe('budget_exhausted');
    expect(res.body.error.scope).toBe('client_key');
    expect(res.body.error.period).toBe('daily');
    // The upstream provider must NOT have been called — budget check fires first.
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('returns 402 when budget is exceeded after prior usage', async () => {
    setBudget('client_key', clientKeyId, { daily_limit_cents: 10 });
    // Pre-burn 10 cents — must set daily_reset_at to today so resetIfNeeded
    // doesn't zero the counter on the next checkAndReserve call.
    const today = new Date().toISOString().slice(0, 10);
    getDb().prepare('UPDATE budgets SET daily_used_cents = 10, daily_reset_at = ? WHERE scope = ? AND scope_id = ?').run(today, 'client_key', clientKeyId);
    const res = await postChat(app, clientKeyAuth);
    expect(res.status).toBe(402);
    expect(res.body.error.type).toBe('budget_exhausted');
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('unified API key is NOT budget-enforced (only client keys)', async () => {
    setBudget('client_key', clientKeyId, { daily_limit_cents: 0 });
    const res = await postChat(app, getUnifiedApiKey());
    expect(res.status).toBe(200);
    expect(chatCompletion).toHaveBeenCalled();
  });
});
