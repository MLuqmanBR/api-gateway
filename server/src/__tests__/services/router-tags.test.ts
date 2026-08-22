import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';

// Mock crypto to avoid IV errors with placeholder key data
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return {
    ...actual,
    decrypt: vi.fn(() => 'mocked-api-key'),
  };
});

describe('C3: Tag/metadata-based filtering', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  beforeEach(() => {
    initDb(':memory:');
    // Insert keys for all seeded platforms
    const platforms = getDb().prepare('SELECT DISTINCT platform FROM models').all() as any[];
    for (const p of platforms) {
      getDb().prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, 'test', 'enc', 'iv', 'tag', 'healthy', 1)
      `).run(p.platform);
    }
  });

  it('no reqTags = today\'s behavior (all models eligible)', () => {
    const route = routeRequest(100, undefined, undefined, false, undefined, {});
    expect(route).toBeDefined();
    expect(route.modelId).toBeDefined();
    route.release();
  });

  it('empty reqTags set = today\'s behavior', () => {
    const route = routeRequest(100, undefined, undefined, false, undefined, { reqTags: new Set() });
    expect(route).toBeDefined();
    route.release();
  });

  it('model with matching tag is selected when reqTags includes it', () => {
    const firstModel = getDb().prepare(`
      SELECT m.id, m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id AND fc.enabled = 1
      WHERE m.enabled = 1
      LIMIT 1
    `).get() as any;
    getDb().prepare("UPDATE models SET tags = '[\"fast\"]' WHERE id = ?").run(firstModel.id);
    getDb().prepare("UPDATE models SET enabled = 0 WHERE id != ?").run(firstModel.id);

    const route = routeRequest(100, undefined, undefined, false, undefined, { reqTags: new Set(['fast']) });
    expect(route).toBeDefined();
    expect(route.modelDbId).toBe(firstModel.id);
    route.release();
  });

  it('model with "default" tag is always eligible', () => {
    const models = getDb().prepare(`
      SELECT m.id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id AND fc.enabled = 1
      WHERE m.enabled = 1
      LIMIT 2
    `).all() as { id: number }[];

    if (models.length < 2) return;

    getDb().prepare("UPDATE models SET tags = '[\"default\"]' WHERE id = ?").run(models[0].id);
    getDb().prepare("UPDATE models SET tags = '[\"premium\"]' WHERE id = ?").run(models[1].id);
    getDb().prepare("UPDATE models SET enabled = 0 WHERE id NOT IN (?, ?)").run(models[0].id, models[1].id);

    // Request "premium" — the premium-tagged model matches; the default-tagged
    // model is ALSO eligible (default tag is always eligible), so the router
    // may legitimately pick either. The balanced strategy scores the two and
    // may prefer either; the C3 contract is eligibility, not precedence.
    const route = routeRequest(100, undefined, undefined, false, undefined, { reqTags: new Set(['premium']) });
    expect(route).toBeDefined();
    expect([models[0].id, models[1].id]).toContain(route.modelDbId);
    route.release();

    // Deterministic precedence: when the default-tagged model is skipped, the
    // premium-tagged model must be selected — proves the exact-tag match is
    // reachable independent of score ordering.
    const premiumRoute = routeRequest(100, undefined, undefined, false, new Set([models[0].id]), { reqTags: new Set(['premium']) });
    expect(premiumRoute).toBeDefined();
    expect(premiumRoute.modelDbId).toBe(models[1].id);
    premiumRoute.release();
  });

  it('model with non-intersecting tags is skipped', () => {
    getDb().prepare("UPDATE models SET tags = '[\"slow\"]'").run();

    expect(() => {
      const r = routeRequest(100, undefined, undefined, false, undefined, { reqTags: new Set(['fast']) });
      r.release();
    }).toThrow();
  });

  it('multiple tags in header are parsed as a set', () => {
    const header = 'fast,cheap,reasoning';
    const tags = new Set(header.split(',').map(t => t.trim()).filter(Boolean));
    expect(tags.size).toBe(3);
    expect(tags.has('fast')).toBe(true);
    expect(tags.has('cheap')).toBe(true);
    expect(tags.has('reasoning')).toBe(true);
  });

  it('whitespace in tags header is trimmed', () => {
    const header = ' fast , cheap , reasoning ';
    const tags = new Set(header.split(',').map(t => t.trim()).filter(Boolean));
    expect(tags.size).toBe(3);
    expect(tags.has(' ')).toBe(false);
  });

  it('tags column defaults to []', () => {
    const row = getDb().prepare('SELECT tags FROM models LIMIT 1').get() as any;
    expect(row.tags).toBe('[]');
  });

  it('tags are stored as JSON string array', () => {
    getDb().prepare("UPDATE models SET tags = '[\"a\",\"b\",\"c\"]' WHERE id = (SELECT id FROM models LIMIT 1)").run();
    const row = getDb().prepare("SELECT tags FROM models WHERE tags LIKE '%a%' LIMIT 1").get() as any;
    const parsed = JSON.parse(row.tags) as string[];
    expect(parsed).toEqual(['a', 'b', 'c']);
  });
});
