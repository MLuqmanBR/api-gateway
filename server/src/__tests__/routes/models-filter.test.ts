import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
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

describe('GET /api/models — enabled-only filter', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterAll(() => {
    // Re-enable every model so later suites in the same process see the
    // standard 25-model seed. The shared migrations only run once per
    // process (initDb is idempotent at the schema level, but our raw
    // UPDATE persists for the life of the in-memory DB).
    getDb().prepare('UPDATE models SET enabled = 1').run();
  });

  it('returns only enabled models', async () => {
    const { status, body } = await request(app, 'GET', '/api/models');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const m of body) {
      expect(m.enabled).toBe(true);
    }
  });

  it('drops models after they are disabled', async () => {
    const before = await request(app, 'GET', '/api/models');
    expect(before.status).toBe(200);
    const beforeIds = new Set(before.body.map((m: { id: number }) => m.id));
    expect(beforeIds.size).toBeGreaterThan(2);

    // Disable two models and verify they vanish from /api/models.
    const toDisable = [...beforeIds].slice(0, 2) as number[];
    const placeholders = toDisable.map(() => '?').join(',');
    getDb()
      .prepare(`UPDATE models SET enabled = 0 WHERE id IN (${placeholders})`)
      .run(...toDisable);

    const after = await request(app, 'GET', '/api/models');
    expect(after.status).toBe(200);
    const afterIds = new Set(after.body.map((m: { id: number }) => m.id));
    for (const id of toDisable) {
      expect(afterIds.has(id)).toBe(false);
    }
    expect(after.body.length).toBe(before.body.length - toDisable.length);
  });

  it('does not return the disabled rows even when fallback_config remains enabled', async () => {
    // Seed-level invariant: fallback_config.enabled stays 1 for disabled
    // models in this repo (migrations only flip models.enabled). The
    // /v1/models handler additionally requires fallback_config.enabled=1,
    // but /api/models deliberately uses the simpler models.enabled check —
    // verifying that contract here.
    const before = await request(app, 'GET', '/api/models');
    expect(before.status).toBe(200);
    const sample = before.body[0] as { id: number; enabled: boolean; fallbackEnabled: boolean };
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(sample.id);

    const after = await request(app, 'GET', '/api/models');
    expect(after.body.find((m: { id: number }) => m.id === sample.id)).toBeUndefined();
  });
});
