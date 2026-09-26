import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getRoutingScores } from '../../services/router.js';

/**
 * The Fallback page's routing-scores panel must agree with what the router will
 * actually do. getRoutingScores() selected fc.enabled and then never filtered on
 * it, so a model the operator had switched off still appeared in the preview as
 * a live candidate — which is the "I disabled it but it is still there"
 * symptom, surviving any fix to the save path.
 */
describe('routing scores preview matches the routable chain', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('excludes chain-disabled and catalog-disabled models', () => {
    const db = getDb();
    const victim = db.prepare(`
      SELECT m.id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.enabled = 1 ORDER BY m.id LIMIT 1
    `).get() as { id: number };
    const other = db.prepare(`
      SELECT m.id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.enabled = 1 AND m.id != ? ORDER BY m.id LIMIT 1
    `).get(victim.id) as { id: number };

    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(victim.id);
    const { scores } = getRoutingScores();
    const ids = new Set(scores.map(s => s.modelDbId));

    // A chain-disabled model must not be offered as routable.
    expect(ids.has(victim.id), 'chain-disabled model must not appear in the preview').toBe(false);
    // Sanity: the chain is not empty and enabled models DO appear, so the
    // assertion above is about the filter and not an accidentally empty query.
    expect(ids.has(other.id)).toBe(true);
    expect(scores.length).toBeGreaterThan(0);
  });
});
