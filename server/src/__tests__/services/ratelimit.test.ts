import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  computeRetryCooldownMs,
  reserveRequest,
  releaseReservation,
} from '../../services/ratelimit.js';

function removeDbFile(dbPath: string) {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Best-effort cleanup for temp SQLite files.
    }
  }
}

describe('Rate Limiter', () => {
  // Use unique identifiers per test to avoid cross-contamination
  let testId: number;

  beforeEach(() => {
    testId = Math.floor(Math.random() * 1_000_000);
  });

  describe('canMakeRequest', () => {
    it('should allow request when under RPM limit', () => {
      expect(canMakeRequest('groq', 'llama-70b', testId, {
        rpm: 30, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    it('should deny request when RPM limit reached', () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      recordRequest('groq', 'llama-70b', testId);
      recordRequest('groq', 'llama-70b', testId);
      expect(canMakeRequest('groq', 'llama-70b', testId, limits)).toBe(false);
    });

    it('X1: per-DAY gate removed — RPD no longer blocks (always allows)', () => {
      const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
      recordRequest('google', 'gemini', testId);
      expect(canMakeRequest('google', 'gemini', testId, limits)).toBe(true);
    });

    it('should allow request when limits are null (unlimited)', () => {
      expect(canMakeRequest('nvidia', 'nemotron', testId, {
        rpm: null, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    // #42 check-then-act race: two concurrent selections reserve provisionally
    // at route time (before either records), and the second must see the cap.
    it('counts optimistic reservations toward the cap so concurrent picks see the limit', () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      // First concurrent request picks the key and reserves.
      const r1 = reserveRequest('groq', 'race-model', testId, 100);
      expect(canMakeRequest('groq', 'race-model', testId, limits)).toBe(true);
      // Second concurrent request picks the same key and reserves — now at cap
      // even though NEITHER has called recordRequest yet.
      const r2 = reserveRequest('groq', 'race-model', testId, 100);
      expect(canMakeRequest('groq', 'race-model', testId, limits)).toBe(false);
      // Rolling back one reservation (abandon/error path) frees a slot again.
      releaseReservation(r2);
      expect(canMakeRequest('groq', 'race-model', testId, limits)).toBe(true);
      releaseReservation(r1);
    });

    it('a reservation also gates token (tpm) and provider caps then clears on release', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      expect(canUseTokens('groq', 'tok-race', id, 5000, { tpm: 8000, tpd: null })).toBe(true);
      const r = reserveRequest('groq', 'tok-race', id, 5000);
      // 5000 reserved + 5000 estimate would exceed 8000.
      expect(canUseTokens('groq', 'tok-race', id, 5000, { tpm: 8000, tpd: null })).toBe(false);
      releaseReservation(r);
      expect(canUseTokens('groq', 'tok-race', id, 5000, { tpm: 8000, tpd: null })).toBe(true);
    });
  });

  describe('canUseTokens', () => {
    it('should allow tokens when under TPM limit', () => {
      expect(canUseTokens('groq', 'llama-70b', testId, 500, {
        tpm: 6000, tpd: null,
      })).toBe(true);
    });

    it('should deny tokens when TPM limit would be exceeded', () => {
      recordTokens('cerebras', 'qwen3', testId, 50000);
      expect(canUseTokens('cerebras', 'qwen3', testId, 20000, {
        tpm: 60000, tpd: null,
      })).toBe(false);
    });

    it('should allow when limit is null', () => {
      expect(canUseTokens('nvidia', 'nemotron', testId, 100000, {
        tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('persistent state', () => {
    it('preserves per-key usage and cooldowns after the limiter module reloads', async () => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      const dbPath = `/tmp/api-gateway-ratelimit-${Date.now()}-${Math.random()}.db`;
      const keyId = 4242;
      let db: { close: () => void } | undefined;

      try {
        vi.resetModules();
        const dbModule = await import('../../db/index.js');
        db = dbModule.initDb(dbPath);
        const limiter = await import('../../services/ratelimit.js');

        limiter.recordRequest('groq', 'persistent-model', keyId);
        limiter.recordTokens('groq', 'persistent-model', keyId, 950);
        limiter.setCooldown('groq', 'persistent-model', keyId, 60_000);
        db.close();
        db = undefined;

        vi.resetModules();
        const dbModuleAfterReload = await import('../../db/index.js');
        db = dbModuleAfterReload.initDb(dbPath);
        const limiterAfterReload = await import('../../services/ratelimit.js');

        expect(limiterAfterReload.canMakeRequest('groq', 'persistent-model', keyId, {
          rpm: 1, rpd: null, tpm: null, tpd: null,
        })).toBe(false);
        expect(limiterAfterReload.canUseTokens('groq', 'persistent-model', keyId, 100, {
          tpm: 1000, tpd: null,
        })).toBe(false);
        expect(limiterAfterReload.isOnCooldown('groq', 'persistent-model', keyId)).toBe(true);
      } finally {
        db?.close();
        removeDbFile(dbPath);
      }
    });
  });

});

describe('Cooldown duration (X1: flat 90s after any error)', () => {
  it('always returns 90s regardless of error class or limits', () => {
    expect(computeRetryCooldownMs(false)).toBe(90_000);
    expect(computeRetryCooldownMs(true)).toBe(90_000); // 402 also flat 90s now
  });
});
