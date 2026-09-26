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

  it('honours an explicit disable while still repairing rows the client never sent', async () => {
    // The two populations a full replace has to treat differently:
    //
    //  (a) rows the client sent as enabled:false  -> the operator's explicit
    //      choice. It must survive; re-enabling it makes the checkbox a no-op.
    //  (b) rows the client never sent at all (enabled elsewhere, e.g. the Keys
    //      page or a PATCH) -> a stale tab would strand them, which is how the
    //      1,230-row drift reappeared after being repaired.
    const { getDb } = await import('../../db/index.js');
    const db = getDb();

    const chosen = db.prepare(`
      SELECT m.id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.enabled = 1 ORDER BY m.id LIMIT 1
    `).get() as { id: number } | undefined;
    expect(chosen).toBeDefined();

    // A model enabled OUTSIDE the chain page, so it is absent from the payload.
    const offChain = db.prepare(`
      SELECT m.id FROM models m WHERE m.enabled = 1 AND m.id != ?
        AND NOT EXISTS (SELECT 1 FROM fallback_config fc WHERE fc.model_db_id = m.id)
       ORDER BY m.id LIMIT 1
    `).get(chosen!.id) as { id: number } | undefined;
    if (offChain) {
      const maxP = (db.prepare('SELECT COALESCE(MAX(priority),0) AS m FROM fallback_config').get() as { m: number }).m;
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)').run(offChain.id, maxP + 1);
    }

    const { body: chain } = await request(app, 'GET', '/api/fallback');
    // Send the chain with exactly ONE model disabled — the operator's intent.
    const payload = chain.map((e: any) => ({
      modelDbId: e.modelDbId,
      priority: e.priority,
      enabled: e.modelDbId !== chosen!.id,
    }));
    const { status } = await request(app, 'PUT', '/api/fallback', payload);
    expect(status).toBe(200);

    // (a) The explicit disable stuck.
    expect((db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(chosen!.id) as { enabled: number }).enabled).toBe(0);

    // (b) The row nobody mentioned is repaired back into the chain.
    if (offChain) {
      expect((db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(offChain.id) as { enabled: number }).enabled).toBe(1);
    }

    // And nothing that the payload left enabled was disturbed.
    const missed = db.prepare(`
      SELECT COUNT(*) AS n FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.enabled = 1 AND fc.enabled = 0
    `).get() as { n: number };
    expect(missed.n).toBe(1);

    // Restore.
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
