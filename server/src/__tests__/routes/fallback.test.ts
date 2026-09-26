import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
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

describe('Fallback API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('GET /api/fallback returns fallback chain', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Should be sorted by priority
    for (let i = 1; i < body.length; i++) {
      expect(body[i].priority).toBeGreaterThanOrEqual(body[i - 1].priority);
    }
  });

  it('GET /api/fallback entries have expected fields', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const first = body[0];
    expect(first).toHaveProperty('modelDbId');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('enabled');
    expect(first).toHaveProperty('platform');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('intelligenceRank');
  });

  it('PUT /api/fallback updates order', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');

    // Reverse the order
    const reversed = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: original.length - i,
      enabled: e.enabled,
    }));

    const { status } = await request(app, 'PUT', '/api/fallback', reversed);
    expect(status).toBe(200);

    // Verify order changed
    const { body: after } = await request(app, 'GET', '/api/fallback');
    expect(after[0].modelDbId).toBe(original[original.length - 1].modelDbId);

    // Restore original order
    const restore = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('POST /api/fallback/sort/intelligence sorts by cross-provider tier, then rank', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/intelligence');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');

    // intelligence_rank is per-provider, so the sort normalizes on the
    // cross-provider capability tier (size_label) first (issue #135).
    const tier: Record<string, number> = { Frontier: 1, Large: 2, Medium: 3, Small: 4 };
    const tierOf = (label: string) => tier[label] ?? 5;

    for (let i = 1; i < body.length; i++) {
      const prevTier = tierOf(body[i - 1].sizeLabel);
      const curTier = tierOf(body[i].sizeLabel);
      // Capability tier never decreases...
      expect(curTier).toBeGreaterThanOrEqual(prevTier);
      // ...and within the same tier, per-provider rank breaks the tie.
      if (curTier === prevTier) {
        expect(body[i].intelligenceRank).toBeGreaterThanOrEqual(body[i - 1].intelligenceRank);
      }
    }
  });

  it('intelligence sort never places a weaker tier above a Frontier model (#135)', async () => {
    await request(app, 'POST', '/api/fallback/sort/intelligence');
    const { body } = await request(app, 'GET', '/api/fallback');

    // The last Frontier model must come before the first non-Frontier model —
    // i.e. no "Intel #1 from a weaker provider" leaks above the frontier tier.
    const lastFrontier = body.map((m: any) => m.sizeLabel).lastIndexOf('Frontier');
    const firstNonFrontier = body.findIndex((m: any) => m.sizeLabel !== 'Frontier');
    if (lastFrontier !== -1 && firstNonFrontier !== -1) {
      expect(lastFrontier).toBeLessThan(firstNonFrontier);
    }
  });

  it('a deliberate disable survives the save', async () => {
    // The reported bug: toggle a model off in the Fallback page, save, and it
    // comes straight back on. The cause was the invariant repair re-enabling
    // exactly the rows the request had just switched off.
    //
    // This replaced an earlier version of itself that asserted the OPPOSITE — it
    // PUT the whole chain as enabled:false and required the server to override
    // all of it. That premise is unsatisfiable: a full-replace PUT narrowing the
    // chain is byte-identical to one sent by a stale tab, so the server cannot
    // honour the operator's choice AND repair stale state from the payload alone.
    // PUT no longer repairs anything; membership is repaired by the writers that
    // can strand a model (see config import).
    const { getDb } = await import('../../db/index.js');
    const db = getDb();
    const off = db.prepare(`
      SELECT m.id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.enabled = 1 ORDER BY m.id LIMIT 1
    `).get() as { id: number };

    const { body: chain } = await request(app, 'GET', '/api/fallback');
    const payload = chain.map((e: any) => ({
      modelDbId: e.modelDbId,
      priority: e.priority,
      enabled: e.modelDbId !== off.id,
    }));
    const { status } = await request(app, 'PUT', '/api/fallback', payload);
    expect(status).toBe(200);

    // The operator's disable STICKS. This is the bug being fixed.
    expect((db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(off.id) as { enabled: number }).enabled).toBe(0);

    // Nothing else was disturbed.
    const others = db.prepare(`
      SELECT COUNT(*) AS n FROM fallback_config fc
       WHERE fc.enabled = 0 AND fc.model_db_id != ?
    `).get(off.id) as { n: number };
    expect(others.n).toBe(0);

    const restore = chain.map((e: any) => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: true }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('PUT /api/fallback re-enables a model when the operator turns it back on', async () => {
    // The inverse direction must still work, otherwise "fixing" the disable
    // would have made the control one-way.
    const { getDb } = await import('../../db/index.js');
    const db = getDb();
    const row = db.prepare(`
      SELECT m.id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.enabled = 1 ORDER BY m.id LIMIT 1
    `).get() as { id: number };
    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(row.id);

    const { body: chain } = await request(app, 'GET', '/api/fallback');
    const payload = chain.map((e: any) => ({
      modelDbId: e.modelDbId,
      priority: e.priority,
      enabled: e.modelDbId === row.id,
    }));
    await request(app, 'PUT', '/api/fallback', payload);

    expect((db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(row.id) as { enabled: number }).enabled).toBe(1);

    const restore = chain.map((e: any) => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: true }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('POST /api/fallback/sort/speed sorts by speed', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/speed');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');
    // Should be sorted ascending by speed rank
    for (let i = 1; i < body.length; i++) {
      expect(body[i].speedRank).toBeGreaterThanOrEqual(body[i - 1].speedRank);
    }
  });

  it('POST /api/fallback/sort/invalid returns 400', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/invalid');
    expect(status).toBe(400);
  });
});
