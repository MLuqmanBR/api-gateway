import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import type { DatabasePort } from '../../db/types.js';
import { resolvePinnedModel } from '../../lib/pinned-model.js';

let db: DatabasePort;

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
  describe('strict <platform>/<model_id> form', () => {
    it('resolves when the pin names the exact platform+model pair', () => {
      const mma = addModel('deepseek', 'deepseek-v4-flash');
      addModel('commandcode', 'deepseek-v4-flash'); // sibling platform
      expect(resolvePinnedModel(db, 'deepseek/deepseek-v4-flash')).toEqual({
        kind: 'resolved',
        modelDbId: mma,
        platform: 'deepseek',
        modelId: 'deepseek-v4-flash',
      });
    });

    it('splits at the FIRST slash so model ids that contain slashes stay intact', () => {
      const kimi = addModel('nvidia', 'moonshotai/kimi-k2.6');
      expect(resolvePinnedModel(db, 'nvidia/moonshotai/kimi-k2.6')).toEqual({
        kind: 'resolved',
        modelDbId: kimi,
        platform: 'nvidia',
        modelId: 'moonshotai/kimi-k2.6',
      });
    });

    it('does NOT resolve a vendor-namespace prefix against the bare id (MiniMaxAI/MiniMax-M3 is not_found)', () => {
      // The id `MiniMaxAI/MiniMax-M3` is stored WHOLE on two platforms. The
      // pin's first segment `MiniMaxAI` is not a platform, and under the
      // strict contract there is no fallback: the exact pair misses → reject.
      addModel('huggingface', 'MiniMaxAI/MiniMax-M3');
      addModel('commandcode', 'MiniMaxAI/MiniMax-M3');
      expect(resolvePinnedModel(db, 'MiniMaxAI/MiniMax-M3')).toEqual({ kind: 'not_found' });
    });

    it('returns disabled when the exact pair exists but enabled=0', () => {
      addModel('nvidia', 'moonshotai/kimi-k2.6', 0);
      expect(resolvePinnedModel(db, 'nvidia/moonshotai/kimi-k2.6')).toEqual({ kind: 'disabled' });
    });

    it('returns not_found when no row carries the platform+model pair', () => {
      expect(resolvePinnedModel(db, 'nope/does-not-exist')).toEqual({ kind: 'not_found' });
    });
  });

  describe('malformed pins (no bare-id shorthand)', () => {
    it('rejects a bare id even when exactly one enabled platform serves it', () => {
      addModel('groq', 'llama-3.3-70b');
      expect(resolvePinnedModel(db, 'llama-3.3-70b')).toEqual({ kind: 'malformed' });
    });

    it('rejects a bare id shared across platforms', () => {
      addModel('groq', 'baremod');
      addModel('nvidia', 'baremod');
      expect(resolvePinnedModel(db, 'baremod')).toEqual({ kind: 'malformed' });
    });

    it('rejects a pin with no slash at all', () => {
      expect(resolvePinnedModel(db, 'never-heard-of-it')).toEqual({ kind: 'malformed' });
    });

    it('rejects an empty platform segment (leading slash)', () => {
      expect(resolvePinnedModel(db, '/llama-3.3-70b')).toEqual({ kind: 'malformed' });
    });

    it('rejects an empty model id segment (trailing slash)', () => {
      expect(resolvePinnedModel(db, 'groq/')).toEqual({ kind: 'malformed' });
    });
  });

  describe('api-gateway/ extension envelope (stripped exactly once)', () => {
    it('strips the prefix and resolves the canonical pin (OMP extension form)', () => {
      const mma = addModel('commandcode', 'MiniMaxAI/MiniMax-M3');
      expect(resolvePinnedModel(db, 'api-gateway/commandcode/MiniMaxAI/MiniMax-M3')).toEqual({
        kind: 'resolved',
        modelDbId: mma,
        platform: 'commandcode',
        modelId: 'MiniMaxAI/MiniMax-M3',
      });
    });

    it('leaves a bare remainder malformed (api-gateway/llama-3.3-70b)', () => {
      addModel('groq', 'llama-3.3-70b');
      expect(resolvePinnedModel(db, 'api-gateway/llama-3.3-70b')).toEqual({ kind: 'malformed' });
    });

    it('treats a doubled prefix as a literal platform (api-gateway/api-gateway/x is not_found)', () => {
      // One strip leaves `api-gateway/groq/x` → platform `api-gateway`, which
      // no catalog row carries → rejected, not unwrapped a second time.
      addModel('groq', 'x');
      expect(resolvePinnedModel(db, 'api-gateway/api-gateway/groq/x')).toEqual({ kind: 'not_found' });
    });

    it('rejects the prefix alone as malformed', () => {
      expect(resolvePinnedModel(db, 'api-gateway/')).toEqual({ kind: 'malformed' });
    });
  });
});
