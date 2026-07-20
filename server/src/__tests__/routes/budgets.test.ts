import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const UNIFIED_KEY = 'test-unified-key-budget-routes';

describe('Budgets API routes (F4)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.TRUST_PROXY = '1';
    initDb(':memory:');
    getDb().prepare('UPDATE settings SET value = ? WHERE key = ?').run(UNIFIED_KEY, 'unifiedApiKey');
    dashToken = mintDashboardToken();
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM budgets').run();
  });

  it('POST /api/budgets creates a budget', async () => {
    const res = await request(app, 'POST', '/api/budgets', { scope: 'global', scope_id: null, daily_limit_cents: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const list = await request(app, 'GET', '/api/budgets');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].daily_limit_cents).toBe(1000);
  });

  it('POST /api/budgets rejects missing scope_id for client_key scope', async () => {
    const res = await request(app, 'POST', '/api/budgets', { scope: 'client_key', daily_limit_cents: 1000 });
    expect(res.status).toBe(400);
  });

  it('POST /api/budgets upserts (changing limits keeps usage)', async () => {
    await request(app, 'POST', '/api/budgets', { scope: 'global', scope_id: null, daily_limit_cents: 1000 });
    getDb().prepare('UPDATE budgets SET daily_used_cents = 500 WHERE scope = ? AND scope_id IS NULL').run('global');
    await request(app, 'POST', '/api/budgets', { scope: 'global', scope_id: null, daily_limit_cents: 2000 });
    const list = await request(app, 'GET', '/api/budgets');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].daily_limit_cents).toBe(2000);
    expect(list.body[0].daily_used_cents).toBe(500);
  });

  it('DELETE /api/budgets removes a budget', async () => {
    await request(app, 'POST', '/api/budgets', { scope: 'global', scope_id: null, daily_limit_cents: 1000 });
    const res = await request(app, 'DELETE', '/api/budgets?scope=global');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const res2 = await request(app, 'DELETE', '/api/budgets?scope=global');
    expect(res2.status).toBe(404);
  });

  it('POST /api/budgets/reset zeros used counters', async () => {
    await request(app, 'POST', '/api/budgets', { scope: 'global', scope_id: null, daily_limit_cents: 1000 });
    getDb().prepare('UPDATE budgets SET daily_used_cents = 500, weekly_used_cents = 300, monthly_used_cents = 200 WHERE scope = ? AND scope_id IS NULL').run('global');
    await request(app, 'POST', '/api/budgets/reset?scope=global');
    const list = await request(app, 'GET', '/api/budgets');
    expect(list.body[0].daily_used_cents).toBe(0);
    expect(list.body[0].weekly_used_cents).toBe(0);
    expect(list.body[0].monthly_used_cents).toBe(0);
  });

  it('rejects unauthenticated remote requests', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/budgets`, {
      headers: { 'X-Forwarded-For': '203.0.113.1' },
    });
    server.close();
    expect(res.status).toBe(401);
  });
});
