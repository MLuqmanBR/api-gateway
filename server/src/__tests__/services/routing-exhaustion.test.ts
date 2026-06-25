import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import * as crypto from '../../lib/crypto.js';

// Mock ratelimit to control quota availability
vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(),
    canUseTokens: vi.fn(),
    isOnCooldown: vi.fn(() => false),
  };
});

// Mock crypto to avoid IV errors
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return {
    ...actual,
    decrypt: vi.fn(() => 'mocked-api-key'),
  };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  if (ORIGINAL_DEV_MODE === undefined) {
    delete process.env.DEV_MODE;
  } else {
    process.env.DEV_MODE = ORIGINAL_DEV_MODE;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe('Routing Key Exhaustion', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // This suite asserts deterministic key/model fallback mechanics, which are
    // strategy-independent — pin the legacy priority order so the bandit's
    // score-based reordering (now the default) doesn't pick seeded catalog
    // models that share the 'google' platform.
    setRoutingStrategy('priority');
    const db = getDb();

    // Setup: 2 models (Pro and Flash)
    // Pro is higher priority (priority 1), Flash is lower (priority 2)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-pro', 'Pro', 1, 1, 1)").run();
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-flash', 'Flash', 2, 2, 1)").run();
    
    const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;
    const flashId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-flash'").get().id;
    
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(proId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(flashId);
    
    // Setup: 2 keys for Google
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('should skip exhausted Key B and use functional Key A for the same high-priority model', () => {
    const db = getDb();
    const keys = db.prepare("SELECT id, label FROM api_keys").all();
    const keyA = keys.find(k => k.label === 'Key A');
    const keyB = keys.find(k => k.label === 'Key B');

    // Mock behavior:
    // Key B is exhausted (returns false for canMakeRequest)
    // Key A is functional (returns true)
    (ratelimit.canMakeRequest as any).mockImplementation((platform, modelId, keyId) => {
      if (keyId === keyB.id) return false;
      if (keyId === keyA.id) return true;
      return true;
    });
    (ratelimit.canUseTokens as any).mockReturnValue(true);

    // Act: Route request
    const result = routeRequest(100);

    // Assert: It should have picked the Pro model despite Key B being exhausted
    expect(result.modelId).toBe('gemini-1.5-pro');
    expect(result.keyId).toBe(keyA.id);
    expect(ratelimit.canMakeRequest).toHaveBeenCalled();
  });

  it('should throw 429 when every key on every model is exhausted', () => {
    (ratelimit.canMakeRequest as any).mockReturnValue(false);
    expect(() => routeRequest(100)).toThrow(/All models exhausted/);
  });

  it('should fall back to Flash when Pro is exhausted but Flash has quota', () => {
    (ratelimit.canMakeRequest as any).mockImplementation((_platform: string, modelId: string) => {
      if (modelId === 'gemini-1.5-pro') return false;
      if (modelId === 'gemini-1.5-flash') return true;
      return true;
    });
    (ratelimit.canUseTokens as any).mockReturnValue(true);

    const result = routeRequest(100);
    expect(result.modelId).toBe('gemini-1.5-flash');
  });

  // 404 model-removed handling: a dead model is skipped ENTIRELY for the rest
  // of the request instead of burning one fallback attempt per key on the same
  // dead route. (PR #111, credits @barbotkonv.)
  describe('skipModels (model-level 404 skip)', () => {
    it('skips every key of a skipped model and routes to the next model', () => {
      const db = getDb();
      const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;

      // Both keys have quota — without skipModels, Pro would be chosen.
      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      const result = routeRequest(100, undefined, undefined, false, false, new Set([proId]));
      expect(result.modelId).toBe('gemini-1.5-flash');
    });

    it('throws when every model is in skipModels', () => {
      const db = getDb();
      const ids = db.prepare('SELECT id FROM models WHERE enabled = 1').all().map((r: any) => r.id);

      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      expect(() => routeRequest(100, undefined, undefined, false, false, new Set(ids))).toThrow();
    });

    it('overrides a sticky/preferred model that has been skipped', () => {
      const db = getDb();
      const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;

      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      // Sticky session prefers Pro, but Pro 404ed earlier in this request.
      const result = routeRequest(100, undefined, proId, false, false, new Set([proId]));
      expect(result.modelId).toBe('gemini-1.5-flash');
    });
  });

  // Round-robin must respect the exhaustion map: an exhausted key stays
  // deprioritized until it is cleared by a successful request, even after
  // its transient cooldown expires. Without this, the 90s transient
  // cooldown expires, the round-robin index wraps back to the other key,
  // and the router re-picks the just-exhausted key — causing the
  // "every-Nth-request-cycle-to-the-broken-key" pattern.
  describe('exhaustion-aware round-robin', () => {
    beforeEach(async () => {
      // Clear any persisted cooldowns / exhaustion from other tests.
      const db = getDb();
      db.prepare('DELETE FROM rate_limit_cooldowns').run();
      const { rebuildExhaustionFromDB } = await import('../../services/key-exhaustion.js');
      rebuildExhaustionFromDB();
    });

    it('keeps picking the unexhausted key across many requests, not round-robin back to the exhausted one', async () => {
      const { markExhausted } = await import('../../services/key-exhaustion.js');
      const db = getDb();
      const keys = db.prepare("SELECT id, label FROM api_keys").all() as Array<{ id: number; label: string }>;
      const keyA = keys.find(k => k.label === 'Key A')!;
      const keyB = keys.find(k => k.label === 'Key B')!;

      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      // Mark Key B as exhausted. Key A remains the healthy one.
      markExhausted(keyB.id, 'google', 'gemini-1.5-pro');

      // 10 successive routeRequests. Every one must land on Key A — the
      // round-robin index should not wrap back to Key B just because
      // enough successful Key A requests have advanced the index past
      // the array length. Key B is reachable only if every other key
      // fails, which is not the case here.
      const pickedKeyIds: number[] = [];
      for (let i = 0; i < 10; i++) {
        const r = routeRequest(100);
        pickedKeyIds.push(r.keyId);
        // Simulate a successful request — the proxy's success path calls
        // clearExhausted(keyId, modelId). Key A is the working one and
        // never gets marked exhausted in this test, so the calls are
        // no-ops on Key A's exhaustion state (Key A wasn't exhausted).
        // We intentionally do NOT clear Key B's exhaustion — that's the
        // whole point of this test.
        if (r.keyId === keyA.id) {
          const { clearExhausted } = await import('../../services/key-exhaustion.js');
          clearExhausted(r.keyId, r.modelId);
        }
      }

      expect(pickedKeyIds).toEqual(Array(10).fill(keyA.id));
    });

    it('reaches the exhausted key only when every unexhausted key has failed', async () => {
      const { markExhausted } = await import('../../services/key-exhaustion.js');
      const db = getDb();
      const keys = db.prepare("SELECT id, label FROM api_keys").all() as Array<{ id: number; label: string }>;
      const keyA = keys.find(k => k.label === 'Key A')!;
      const keyB = keys.find(k => k.label === 'Key B')!;

      // Mark Key A as exhausted, Key B as healthy.
      markExhausted(keyA.id, 'google', 'gemini-1.5-pro');
      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      // First call should pick Key B (unexhausted), not Key A.
      const r1 = routeRequest(100);
      expect(r1.keyId).toBe(keyB.id);

      // The unexhausted key successfully serves a request. Key A remains
      // in the exhausted bucket.
      const { clearExhausted } = await import('../../services/key-exhaustion.js');
      clearExhausted(r1.keyId, r1.modelId);

      // Second call: still Key B (Key A still exhausted).
      const r2 = routeRequest(100);
      expect(r2.keyId).toBe(keyB.id);
    });
  });

  // Pinned-model pre-filter fallback (#256): when every key for a pinned
  // model is rejected by the cooldown/RPM/RPD pre-filter, the router used
  // to throw PINNED_MODEL_EXHAUSTED immediately — leaving the proxy no
  // chance to attempt the provider call or run its 3-retry cycle. The
  // fix is a fallback that returns the first available key anyway so
  // the proxy can confirm the rate limit with the provider.
  describe('pinned-model pre-filter fallback (#256)', () => {
    it('returns the first available key for a pinned model even when every key fails the pre-filter', () => {
      const db = getDb();
      const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;
      const keys = db.prepare("SELECT id, label FROM api_keys").all() as Array<{ id: number; label: string }>;

      // Every key is at the RPM cap — the main pass rejects both.
      (ratelimit.canMakeRequest as any).mockReturnValue(false);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      // Before the fix this would throw PINNED_MODEL_EXHAUSTED. After the
      // fix the pinned-model fallback returns one of the available keys so
      // the proxy can attempt the call and run its 3-retry cycle. The
      // specific key picked depends on the round-robin index — the main
      // pass starts at the round-robin cursor and increments it even when
      // no key passes, so the fallback starts at the next position.
      const result = routeRequest(100, undefined, proId, false, false, undefined, { pinMode: true });
      expect(result.modelId).toBe('gemini-1.5-pro');
      expect(keys.map(k => k.id)).toContain(result.keyId);
    });

    it('still throws PINNED_MODEL_EXHAUSTED when no key is available at all (e.g. all keys disabled)', () => {
      const db = getDb();
      const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;

      // Disable both keys so the SQL query at router.ts:541 returns empty.
      db.prepare("UPDATE api_keys SET enabled = 0").run();

      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      // keys.length === 0 → throws PINNED_MODEL_EXHAUSTED at line 545-553,
      // before the fallback even runs. This is the correct behavior — if
      // there are literally no keys to try, there's nothing to fall back to.
      expect(() => routeRequest(100, undefined, proId, false, false, undefined, { pinMode: true }))
        .toThrow(/Pinned model exhausted/);
    });
  });
});
