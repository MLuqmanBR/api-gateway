import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import {
  computeCacheKey,
  isCacheableTemp,
  isCacheBypassed,
  getCachedResponse,
  setCachedResponse,
  purgeCache,
  getCacheStats,
  synthesizeSSE,
  isCacheEnabled,
} from '../../services/cache.js';

describe('Response cache service (F5)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    purgeCache(); // clears both L1 and L2
    setSetting('cache_enabled', 'true');
    setSetting('cache_ttl_seconds', '86400');
  });

  it('computeCacheKey is deterministic for identical inputs', () => {
    const params = {
      model: 'groq/llama',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0,
    };
    const k1 = computeCacheKey(params);
    const k2 = computeCacheKey(params);
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(64); // SHA-256 hex
  });

  it('computeCacheKey differs when model differs', () => {
    const base = { model: 'groq/llama', messages: [{ role: 'user', content: 'Hi' }], temperature: 0 };
    const k1 = computeCacheKey(base);
    const k2 = computeCacheKey({ ...base, model: 'openai/gpt-4' });
    expect(k1).not.toBe(k2);
  });

  it('computeCacheKey differs when messages differ', () => {
    const base = { model: 'auto', messages: [{ role: 'user', content: 'Hi' }], temperature: 0 };
    const k1 = computeCacheKey(base);
    const k2 = computeCacheKey({ ...base, messages: [{ role: 'user', content: 'Bye' }] });
    expect(k1).not.toBe(k2);
  });

  it('isCacheableTemp: only temperature === 0 is cacheable', () => {
    expect(isCacheableTemp(0, undefined)).toBe(true);
    expect(isCacheableTemp(0, 1)).toBe(true);
    expect(isCacheableTemp(1, undefined)).toBe(false);
    expect(isCacheableTemp(0.1, undefined)).toBe(false);
    expect(isCacheableTemp(undefined, undefined)).toBe(false); // defaults to 1.0
  });

  it('isCacheBypassed: X-No-Cache header bypasses', () => {
    expect(isCacheBypassed(undefined, '1')).toBe(true);
    expect(isCacheBypassed(undefined, undefined)).toBe(false);
  });

  it('isCacheBypassed: cache.no_cache directive bypasses', () => {
    expect(isCacheBypassed({ no_cache: true }, undefined)).toBe(true);
    expect(isCacheBypassed({ 'no-cache': true }, undefined)).toBe(true);
    expect(isCacheBypassed({ no_store: true }, undefined)).toBe(true);
    expect(isCacheBypassed({ ttl: 60 }, undefined)).toBe(false);
  });

  it('setCachedResponse + getCachedResponse round-trip', () => {
    const key = computeCacheKey({ model: 'auto', messages: [{ role: 'user', content: 'Hi' }], temperature: 0 });
    const payload = JSON.stringify({ id: 'test', choices: [{ message: { content: 'Hello!' } }] });
    expect(getCachedResponse(key)).toBeNull();
    setCachedResponse(key, payload);
    expect(getCachedResponse(key)).toBe(payload);
  });

  it('L1 cache serves hits even after L2 deletion', () => {
    const key = computeCacheKey({ model: 'auto', messages: [{ role: 'user', content: 'L1' }], temperature: 0 });
    const payload = JSON.stringify({ id: 'l1', choices: [] });
    setCachedResponse(key, payload);
    getCachedResponse(key); // promote to L1
    getDb().prepare('DELETE FROM response_cache WHERE key = ?').run(key); // delete L2
    expect(getCachedResponse(key)).toBe(payload); // served from L1
  });

  it('expired L2 entries are evicted on read (TTL)', () => {
    const key = computeCacheKey({ model: 'auto', messages: [{ role: 'user', content: 'TTL' }], temperature: 0 });
    setCachedResponse(key, JSON.stringify({ id: 'ttl' }));
    // Backdate the L2 entry to 25h ago and clear L1 via purge, then restore L2
    const old = Date.now() - 25 * 3600 * 1000;
    getDb().prepare('UPDATE response_cache SET created_at_ms = ? WHERE key = ?').run(old, key);
    // Clear L1 without deleting L2: save the backdated L2 row, purge (deletes both), re-insert
    const saved = getDb().prepare('SELECT response_json, created_at_ms FROM response_cache WHERE key = ?').get(key) as
      { response_json: string; created_at_ms: number };
    purgeCache();
    getDb().prepare('INSERT INTO response_cache (key, response_json, created_at_ms, hits, tokens_saved) VALUES (?, ?, ?, 0, 0)').run(key, saved.response_json, saved.created_at_ms);
    // Now L1 is empty, L2 has the backdated entry — read should evict
    expect(getCachedResponse(key)).toBeNull();
    const row = getDb().prepare('SELECT key FROM response_cache WHERE key = ?').get(key);
    expect(row).toBeUndefined();
  });

  it('purgeCache clears both tiers', () => {
    const key = computeCacheKey({ model: 'auto', messages: [{ role: 'user', content: 'purge' }], temperature: 0 });
    setCachedResponse(key, JSON.stringify({ id: 'p' }));
    expect(purgeCache()).toBeGreaterThan(0);
    expect(getCachedResponse(key)).toBeNull();
    expect(getCacheStats().entries).toBe(0);
  });

  it('getCacheStats reports entries and hits (L1 hit counters batched — L17)', () => {
    const key = computeCacheKey({ model: 'auto', messages: [{ role: 'user', content: 'stats' }], temperature: 0 });
    setCachedResponse(key, JSON.stringify({ id: 's' }));
    const before = getCacheStats().hits;
    getCachedResponse(key); // L1 hit 1 — setCachedResponse already seeded L1
    getCachedResponse(key); // L1 hit 2 — accrued in memory, not yet written
    expect(getCacheStats().entries).toBe(1);
    expect(getCacheStats().hits).toBe(before); // batched residue not flushed yet
    // 14 more L1 hits reach HIT_FLUSH_EVERY(16): the pending batch flushes
    // as one UPDATE.
    for (let i = 0; i < 14; i++) getCachedResponse(key);
    expect(getCacheStats().hits).toBe(before + 16);
  });

  it('isCacheEnabled defaults to true, opt-out via setting', () => {
    setSetting('cache_enabled', 'true');
    expect(isCacheEnabled()).toBe(true);
    setSetting('cache_enabled', 'false');
    expect(isCacheEnabled()).toBe(false);
    // Unset = default true
    getDb().prepare("DELETE FROM settings WHERE key = 'cache_enabled'").run();
    expect(isCacheEnabled()).toBe(true);
  });

  it('synthesizeSSE produces valid SSE with [DONE] terminator', () => {
    const cached = JSON.stringify({
      id: 'test-cmpl',
      model: 'groq/test',
      choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }],
    });
    const sse = synthesizeSSE(cached);
    expect(sse).toContain('data: ');
    expect(sse).toContain('"role":"assistant"');
    expect(sse).toContain('"content":"Hi there"');
    expect(sse).toContain('"finish_reason":"stop"');
    expect(sse.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('TTL=0 means everything is immediately expired', () => {
    setSetting('cache_ttl_seconds', '0');
    const key = computeCacheKey({ model: 'auto', messages: [{ role: 'user', content: 'zero' }], temperature: 0 });
    setCachedResponse(key, JSON.stringify({ id: 'zero' }));
    expect(getCachedResponse(key)).toBeNull();
  });
});
