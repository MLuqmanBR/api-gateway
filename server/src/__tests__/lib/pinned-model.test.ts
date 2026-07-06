import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import type Database from 'better-sqlite3';
import { resolvePinnedModel } from '../../lib/pinned-model.js';

let db: Database.Database;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
});

beforeEach(() => {
  // Fresh in-memory DB per test, then wipe the catalog migration seed so each
  db = initDb(':memory:');
  // Wipe the migration-seeded catalog. fallback_config.model_db_id has an FK
  // to models(id), so clear the dependent table first.
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM models').run();
});

/** Insert one model row. `enabled` defaults to 1. */
function addModel(platform: string, modelId: string, enabled: 0 | 1 = 1): number {
  const r = db.prepare(
    `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
     VALUES (?, ?, ?, 1, 1, '', ?)`,
  ).run(platform, modelId, `${platform}/${modelId}`, enabled);
  return Number(r.lastInsertRowid);
}

describe('resolvePinnedModel', () => {
  describe('Path A: platform/model_id wire form (the documented contract)', () => {
    it('resolves uniquely when the client pins the advertised platform/model_id', () => {
      const mma = addModel('deepseek', 'deepseek-v4-flash');
      addModel('commandcode', 'deepseek-v4-flash'); // sibling platform
      expect(resolvePinnedModel(db, 'deepseek/deepseek-v4-flash')).toEqual({
        kind: 'resolved',
        modelDbId: mma,
      });
    });

    it('treats the first-segment as the explicit platform choice even when it also collides with a sibling namespace (deepseek/deepseek-v4-flash stays deepseek, not ambiguous)', () => {
      // The wire contract is `platform/model_id`; `deepseek` is a real
      // platform here, so the client explicitly chose deepseek — we must NOT
      // surface `ambiguous` just because commandcode also serves the id.
      const ds = addModel('deepseek', 'deepseek-v4-flash');
      addModel('commandcode', 'deepseek-v4-flash');
      const r = resolvePinnedModel(db, 'deepseek/deepseek-v4-flash');
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') expect(r.modelDbId).toBe(ds);
    });

    it('returns disabled when the pinned platform+model pair exists but enabled=0', () => {
      addModel('nvidia', 'moonshotai/kimi-k2.6', 0);
      expect(resolvePinnedModel(db, 'nvidia/moonshotai/kimi-k2.6')).toEqual({ kind: 'disabled' });
    });

    it('returns not_found when no platform+model row exists at all (not even disabled)', () => {
      expect(resolvePinnedModel(db, 'nope/does-not-exist')).toEqual({ kind: 'not_found' });
    });

    it('falls through to Path B when the first segment is NOT a real platform (MiniMaxAI/MiniMax-M3 misses the platform-qualified query)', () => {
      // `MiniMaxAI` is a vendor namespace fragment, not a platform slug.
      // The platform-qualified query misses; the bare-id fallback then sees
      // the multiple enabled rows that share this model_id → ambiguous.
      addModel('huggingface', 'MiniMaxAI/MiniMax-M3');
      addModel('commandcode', 'MiniMaxAI/MiniMax-M3');
      const r = resolvePinnedModel(db, 'MiniMaxAI/MiniMax-M3');
      expect(r.kind).toBe('ambiguous');
      if (r.kind === 'ambiguous') {
        expect(r.platforms.sort()).toEqual(['commandcode', 'huggingface']);
      }
    });
  });

  describe('Path B: bare id (no slash) — backward-compat shorthand', () => {
    it('resolves when exactly one enabled platform serves the bare id', () => {
      const sole = addModel('groq', 'llama-3.3-70b');
      expect(resolvePinnedModel(db, 'llama-3.3-70b')).toEqual({ kind: 'resolved', modelDbId: sole });
    });

    it('returns ambiguous when two-or-more enabled platforms share the bare id', () => {
      addModel('huggingface', 'MiniMaxAI/MiniMax-M3');
      addModel('commandcode', 'MiniMaxAI/MiniMax-M3');
      const r = resolvePinnedModel(db, 'MiniMaxAI/MiniMax-M3');
      expect(r.kind).toBe('ambiguous');
      if (r.kind === 'ambiguous') {
        expect(r.platforms.sort()).toEqual(['commandcode', 'huggingface']);
      }
    });

    it('returns disabled when the only row is enabled=0', () => {
      addModel('groq', 'llama-3.3-70b', 0);
      expect(resolvePinnedModel(db, 'llama-3.3-70b')).toEqual({ kind: 'disabled' });
    });

    it('returns not_found when no row exists at all', () => {
      expect(resolvePinnedModel(db, 'never-heard-of-it')).toEqual({ kind: 'not_found' });
    });
  });

  describe('api-gateway/ extension prefix stripping', () => {
    it('strips the api-gateway/ prefix before resolving (OMP additional-providers-extension form)', () => {
      const mma = addModel('commandcode', 'MiniMaxAI/MiniMax-M3');
      addModel('huggingface', 'MiniMaxAI/MiniMax-M3');
      const r = resolvePinnedModel(db, 'api-gateway/commandcode/MiniMaxAI/MiniMax-M3');
      expect(r).toEqual({ kind: 'resolved', modelDbId: mma });
    });
  });
});
