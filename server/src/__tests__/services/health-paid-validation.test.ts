/**
 * Who is allowed to spend the operator's paid quota when checking a key.
 *
 * CommandCode exposes no free auth-check route: every GET (models, me, usage,
 * credits, balance, plan, health) answers 404, so `validateKey` has to POST a
 * real /alpha/generate. Each probe consumes one of the account's plan credits,
 * and a scheduled sweep fires once per key per cycle — up to 288 paid
 * generations per key per day at the default 5-minute interval, burned purely on
 * health bookkeeping.
 *
 * The rule the three call sites encode:
 *   - scheduled sweep  -> never pays (default false)
 *   - "Check all"      -> pays (the click is an explicit request for a verdict)
 *   - single-key "test"-> pays (checkKeyHealth is deliberately unguarded)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import type { KeyStatus } from '@api-gateway/shared/types.js';

const calls = vi.hoisted(() => ({
  platforms: [] as string[],
  // Read per call: buildProviderFor returns a fresh object literal every time,
  // so mutating a returned provider would be lost before checkKeyHealth re-
  // resolves it.
  returnValue: true,
}));

vi.mock('../../providers/index.js', () => ({
  buildProviderFor: (platform: string) => ({
    platform,
    name: `${platform} (mock)`,
    baseUrl: `https://${platform}.example.test/v1`,
    validateCostsQuota: platform === 'billable',
    validateKey: (key: string) => {
      calls.platforms.push(platform);
      void key;
      return Promise.resolve(calls.returnValue);
    },
  }),
  hasProvider: () => true,
}));

// Rows below carry placeholder ciphertext that would fail real decryption, and
// decrypt failure short-circuits before the request is ever built.
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/crypto.js')>('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

function insertKey(id: number, platform: string, status: KeyStatus = 'healthy') {
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, 'enc', 'iv', 'tag', ?, 1)
  `).run(id, platform, `${platform}-key`, status);
}

function keyRow(id: number) {
  return getDb().prepare('SELECT status, enabled, last_checked_at FROM api_keys WHERE id = ?')
    .get(id) as { status: KeyStatus; enabled: number; last_checked_at: string | null } | undefined;
}

describe('scheduled sweep never pays for validation', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    calls.platforms = [];
    calls.returnValue = true;
  });

  it('checkAllKeys() does not probe a provider flagged validateCostsQuota', async () => {
    const { checkAllKeys } = await import('../../services/health.js');
    insertKey(900, 'billable');

    await checkAllKeys();

    expect(calls.platforms).toEqual([]);
  });

  it('leaves a skipped key completely untouched, including an invalid one', async () => {
    // Nothing was verified, so nothing may be written. Stamping 'unknown' would
    // downgrade a CONFIRMED invalid key, and because routeRequest accepts
    // 'unknown' that resurrects a revoked token on every cycle — the same class
    // of bug markKeyHealthyFromRequest guards against with
    // `AND status IN ('error','unknown')`.
    const { checkAllKeys } = await import('../../services/health.js');
    insertKey(901, 'billable', 'invalid');
    const before = keyRow(901)!;

    await checkAllKeys();
    const after = keyRow(901)!;

    expect(after.status).toBe('invalid');
    expect(after.last_checked_at).toBe(before.last_checked_at);
    expect(calls.platforms).toEqual([]);
  });

  it('still probes providers whose check path is free', async () => {
    // The flag must not become a blanket "stop checking things".
    const { checkAllKeys } = await import('../../services/health.js');
    insertKey(902, 'billable');
    insertKey(903, 'freecheck');

    await checkAllKeys();

    expect(calls.platforms).toEqual(['freecheck']);
    expect(keyRow(903)!.status).toBe('healthy');
    expect(keyRow(903)!.last_checked_at).toBeTruthy();
  });

  it('reports the skip count once per sweep, not once per key', async () => {
    const { checkAllKeys } = await import('../../services/health.js');
    insertKey(910, 'billable');
    insertKey(911, 'billable');
    insertKey(912, 'freecheck');

    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '));
    });
    try {
      await checkAllKeys();
    } finally {
      spy.mockRestore();
    }

    const summary = logged.find(l => l.includes('[Health] Check complete'));
    expect(summary).toMatch(/Skipped 2 key\(s\)/);
    // Per-key logging would be hundreds of lines a day at the default interval.
    expect(logged.filter(l => /skipped.*key 9/i.test(l))).toEqual([]);
  });

  it('never auto-disables a key for never being probed', async () => {
    // Auto-disable counts three consecutive failed checks. A skip is not a
    // failed check.
    const { checkAllKeys } = await import('../../services/health.js');
    insertKey(920, 'billable');
    for (let i = 0; i < 3; i++) await checkAllKeys();

    expect(keyRow(920)!.enabled).toBe(1);
    expect(calls.platforms).toEqual([]);
  });
});

describe('explicit user actions still pay for a real verdict', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    calls.platforms = [];
    calls.returnValue = true;
  });

  it('checkAllKeys(true) probes a billable provider', async () => {
    // What POST /api/health/check-all passes. An operator clicking "Check all"
    // asked for a live verdict; inheriting the false default would skip exactly
    // the keys they most want checked.
    const { checkAllKeys } = await import('../../services/health.js');
    insertKey(930, 'billable', 'unknown');

    await checkAllKeys(true);

    expect(calls.platforms).toEqual(['billable']);
    expect(keyRow(930)!.status).toBe('healthy');
  });

  it('runCheckAllGuarded forwards the flag', async () => {
    const { runCheckAllGuarded } = await import('../../services/health.js');
    insertKey(931, 'billable');

    expect(await runCheckAllGuarded()).toBe(true);
    expect(calls.platforms).toEqual([]);

    expect(await runCheckAllGuarded(true)).toBe(true);
    expect(calls.platforms).toEqual(['billable']);
  });

  it('checkKeyHealth probes even when validateCostsQuota is set', async () => {
    // The Keys page "test" button POSTs /api/health/check/:keyId, which calls
    // checkKeyHealth directly. Guarding it there would make the button a silent
    // no-op — one paid probe on an explicit action is justified.
    const { checkKeyHealth } = await import('../../services/health.js');
    insertKey(932, 'billable', 'unknown');

    expect(await checkKeyHealth(932)).toBe('healthy');
    expect(calls.platforms).toEqual(['billable']);
  });

  it('checkKeyHealth still reports an invalid key as invalid', async () => {
    const { checkKeyHealth } = await import('../../services/health.js');
    insertKey(933, 'billable');
    calls.returnValue = false;
    try {
      expect(await checkKeyHealth(933)).toBe('invalid');
    } finally {
      calls.returnValue = true;
    }
    // The verdict came from upstream, not from a skip.
    expect(calls.platforms).toEqual(['billable']);
  });
});
