/**
 * Chain MEMBERSHIP: a model the operator has enabled must have a fallback_config
 * row, or routeRequest's chain can never see it (the router requires
 * `fc.enabled = 1` AND `m.enabled = 1`).
 *
 * Two halves, and they are the whole doctrine:
 *
 *  1. A missing row is a defect and is repaired (insert-only, with DISTINCT
 *     sequential priorities).
 *  2. An existing row's `fc.enabled` belongs to the operator. No helper in this
 *     file may set it back to 1, from any caller. That second half is what the
 *     Fallback page's "I disable a model and it comes straight back on" bug
 *     was, and it was reachable through more than one endpoint.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { ensureInChain, ensurePlatformInChain, ensureCatalogInChain } from '../../db/chain.js';

/** A model that is enabled in the catalog but has no chain row. */
function makeOrphan(platform: string, modelId: string): number {
  getDb().prepare(
    'INSERT INTO models (platform, model_id, display_name, enabled, intelligence_rank, ' +
    'speed_rank, size_label, max_output_tokens) VALUES (?,?,?,1,1,1,\'Medium\',4096)',
  ).run(platform, modelId, modelId);
  return (getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number }).id;
}

function chainEnabled(id: number): number | undefined {
  return (getDb().prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?')
    .get(id) as { enabled: number } | undefined)?.enabled;
}

function priorityOf(id: number): number | undefined {
  return (getDb().prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?')
    .get(id) as { priority: number } | undefined)?.priority;
}

describe('chain membership helpers', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('ensureInChain appends a row for a model that has none', () => {
    const id = makeOrphan('p1', 'm1');
    expect(ensureInChain(getDb(), id)).toBe('appended');
    expect(chainEnabled(id)).toBe(1);
  });

  it('ensureInChain leaves an existing row and its switch completely alone', () => {
    // The defect, in miniature. The operator switches a model off; a helper
    // called from some other endpoint must not turn it back on.
    const id = makeOrphan('p1', 'm1');
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 7, 0)').run(id);

    expect(ensureInChain(getDb(), id)).toBe('present');
    expect(chainEnabled(id)).toBe(0);
    expect(priorityOf(id)).toBe(7);
  });

  it('ensurePlatformInChain adds only the models missing a row', () => {
    const a = makeOrphan('p2', 'a');
    const b = makeOrphan('p2', 'b');
    const kept = makeOrphan('p2', 'kept');
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 3, 0)').run(kept);

    expect(ensurePlatformInChain(getDb(), 'p2')).toBe(2);
    expect(chainEnabled(a)).toBe(1);
    expect(chainEnabled(b)).toBe(1);
    // The curated row keeps both its switch and its priority.
    expect(chainEnabled(kept)).toBe(0);
    expect(priorityOf(kept)).toBe(3);
  });

  it('ensurePlatformInChain ignores catalog-disabled models', () => {
    const on = makeOrphan('p3', 'on');
    const off = makeOrphan('p3', 'off');
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(off);

    ensurePlatformInChain(getDb(), 'p3');
    expect(chainEnabled(on)).toBe(1);
    expect(chainEnabled(off)).toBeUndefined();
  });

  it('ensureCatalogInChain appends missing rows at distinct, increasing priorities', () => {
    // Guards the ROW_NUMBER window. Wrapping it in a scalar subquery makes it
    // evaluate once over a single virtual row, so every inserted model gets the
    // SAME priority and they all tie at the tail — verified against SQLite
    // directly, and it silently destroys the operator's ordering.
    const a = makeOrphan('p4', 'a');
    const b = makeOrphan('p4', 'b');
    const c = makeOrphan('p4', 'c');
    const maxP = (getDb().prepare('SELECT COALESCE(MAX(priority),0) AS m FROM fallback_config').get() as { m: number }).m;

    expect(ensureCatalogInChain(getDb())).toBe(3);

    const pa = priorityOf(a)!;
    const pb = priorityOf(b)!;
    const pc = priorityOf(c)!;
    // Appended AFTER everything already in the chain, in model-id order, and no
    // two of them collide.
    expect(pa).toBeGreaterThan(maxP);
    expect([pa, pb, pc].sort((x, y) => x - y)).toEqual([maxP + 1, maxP + 2, maxP + 3]);
    expect(new Set([pa, pb, pc]).size).toBe(3);
  });

  it('ensureCatalogInChain never re-enables a row the operator switched off', () => {
    const id = makeOrphan('p5', 'm');
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 0)').run(id);

    // A row exists, so this model is not "missing" and must be left alone.
    expect(ensureCatalogInChain(getDb())).toBe(0);
    expect(chainEnabled(id)).toBe(0);
    expect(priorityOf(id)).toBe(2);
  });

  it('ensureCatalogInChain is a no-op when every enabled model already has a row', () => {
    // Every model in a freshly seeded DB is a member, so this must not append a
    // single duplicate — otherwise a save would balloon the table.
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM fallback_config').get() as { n: number }).n;
    expect(ensureCatalogInChain(getDb())).toBe(0);
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM fallback_config').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
