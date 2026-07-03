import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canMakeRequest,
  canUseProviderMinute,
  providerMinuteRequestCount,
  getProviderMinuteRequestCap,
  recordRequest,
  recordTokens,
} from '../../services/ratelimit.js';

// Provider-wide per-minute cap (#295). Mirror of ratelimit.test.ts's daily-cap
// block, but minute-windowed. The bug this gates: NVIDIA NIM enforces ONE
// shared 40 RPM budget across EVERY model under one key; the per-(platform,
// model, key) rpm ledger in canMakeRequest sees each model in isolation, so a
// manually-added model row with rpm_limit=NULL escaped the per-model gate
// entirely while sibling GLM rows self-throttled — "glm-5.2 exhausts all keys,
// minimax-m3 works on the same key".

describe('Provider-wide per-minute request cap (#295)', () => {
  const ENV = 'PROVIDER_MINUTE_REQUEST_CAP_NVIDIA';
  let original: string | undefined;
  let testId: number;

  beforeEach(() => {
    testId = Math.floor(Math.random() * 1_000_000);
    original = process.env[ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('defaults nvidia to 40 RPM and allows env override / disable', () => {
    delete process.env[ENV];
    expect(getProviderMinuteRequestCap('nvidia')).toBe(40);
    expect(getProviderMinuteRequestCap('groq')).toBeNull(); // no shared cap
    process.env[ENV] = '20';
    expect(getProviderMinuteRequestCap('nvidia')).toBe(20);
    process.env[ENV] = '0'; // 0 disables the cap
    expect(getProviderMinuteRequestCap('nvidia')).toBeNull();
  });

  it('counts requests across ALL of a provider\'s models for one key within the minute window', () => {
    recordRequest('nvidia', 'z-ai/glm-5.2', testId);
    recordRequest('nvidia', 'z-ai/glm-5.2', testId);
    recordRequest('nvidia', 'minimaxai/minimax-m3', testId);
    // Same key on a different provider must not bleed into the count.
    recordRequest('groq', 'llama-70b', testId);
    expect(providerMinuteRequestCount('nvidia', testId)).toBe(3);
  });

  it('blocks the whole provider+key once the shared per-minute cap is hit', () => {
    process.env[ENV] = '3';
    recordRequest('nvidia', 'model-a', testId);
    recordRequest('nvidia', 'model-b', testId);
    expect(canUseProviderMinute('nvidia', testId, 100)).toBe(true); // 2 < 3
    recordRequest('nvidia', 'model-c', testId);
    expect(canUseProviderMinute('nvidia', testId, 100)).toBe(false); // 3 >= 3
  });

  // The core asymmetry the user reported: glm-5.2 has rpm_limit=40 seeded and
  // self-throttles per-model; minimax-m3 had rpm_limit=NULL and escaped the
  // per-model gate entirely. The provider-wide gate must catch the shared
  // overflow that the per-model gate misses.
  it('catches the shared-budget overflow the per-model gate misses (the glm-5.2 vs minimax-m3 asymmetry)', () => {
    delete process.env[ENV];
    const limits40 = { rpm: 40, rpd: null, tpm: null, tpd: null };
    const limitsNull = { rpm: null, rpd: null, tpm: null, tpd: null };

    // Interleave 20 requests on each of two nvidia models — 40 shared total.
    for (let i = 0; i < 20; i++) {
      recordRequest('nvidia', 'z-ai/glm-5.2', testId);
      recordRequest('nvidia', 'minimaxai/minimax-m3', testId);
    }

    // Per-model ledger: each model only saw 20, so canMakeRequest still passes
    // for BOTH — even the seeded-40 GLM row has not hit its per-model cap.
    expect(canMakeRequest('nvidia', 'z-ai/glm-5.2', testId, limits40)).toBe(true);
    expect(canMakeRequest('nvidia', 'minimaxai/minimax-m3', testId, limits40)).toBe(true);
    // And the NULL-rpm_limit minimax-m3 row sails through with no per-model cap.
    expect(canMakeRequest('nvidia', 'minimaxai/minimax-m3', testId, limitsNull)).toBe(true);

    // BUT the provider-wide gate sees the real shared 40, so it blocks — this
    // is the gate that was missing and let each model row be accounted in
    // isolation against a shared account budget.
    expect(providerMinuteRequestCount('nvidia', testId)).toBe(40);
    expect(canUseProviderMinute('nvidia', testId, 100)).toBe(false);
  });
});

describe('Provider-wide per-minute token cap (#295)', () => {
  const ENV = 'PROVIDER_MINUTE_TOKEN_CAP_NVIDIA';
  let original: string | undefined;
  let testId: number;

  beforeEach(() => {
    testId = Math.floor(Math.random() * 1_000_000);
    original = process.env[ENV];
    delete process.env[ENV];
    // Ensure the request cap does not interfere with the token test.
    process.env['PROVIDER_MINUTE_REQUEST_CAP_NVIDIA'] = '0';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
    delete process.env['PROVIDER_MINUTE_REQUEST_CAP_NVIDIA'];
  });

  it('blocks a key when the next request would exceed the shared per-minute token cap', () => {
    process.env[ENV] = '10000';
    recordTokens('nvidia', 'z-ai/glm-5.2', testId, 4000);
    recordTokens('nvidia', 'minimaxai/minimax-m3', testId, 4000); // 8000 shared
    // 8000 + 2500 = 10500 > 10000 -> blocked
    expect(canUseProviderMinute('nvidia', testId, 2500)).toBe(false);
    // but 8000 + 1500 = 9500 <= 10000 -> allowed
    expect(canUseProviderMinute('nvidia', testId, 1500)).toBe(true);
  });

  it('is uncapped when no env var, DB row, or default applies', () => {
    delete process.env[ENV];
    expect(canUseProviderMinute('groq', testId, 10_000_000)).toBe(true);
  });
});
