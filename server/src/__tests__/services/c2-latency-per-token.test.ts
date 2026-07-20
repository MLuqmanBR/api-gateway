import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, setSetting, getSetting } from '../../db/index.js';
import { logRequest } from '../../routes/proxy.js';

describe('C2: TTFT-per-token latency scoring', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    setSetting('bandit_breaker', 'off');
  });

  it('logRequest records latency_per_token_ms when outputTokens > 0', () => {
    logRequest('groq', 'llama-3', 1, 'success', 100, 50, 5000, null, null, null);
    const row = getDb().prepare('SELECT latency_per_token_ms FROM requests WHERE platform = ? AND model_id = ?').get('groq', 'llama-3') as any;
    expect(row.latency_per_token_ms).toBe(100); // 5000ms / 50 tokens = 100ms/token
  });

  it('logRequest records null latency_per_token_ms when outputTokens = 0', () => {
    logRequest('groq', 'llama-3', 1, 'error', 100, 0, 3000, 'timeout', null, null);
    const row = getDb().prepare('SELECT latency_per_token_ms FROM requests WHERE platform = ? AND model_id = ?').get('groq', 'llama-3') as any;
    expect(row.latency_per_token_ms).toBeNull();
  });

  it('latency_per_token_ms is computed correctly for streaming (TTFT)', () => {
    logRequest('openai', 'gpt-4', 1, 'success', 500, 100, 2000, null, 300, null);
    const row = getDb().prepare('SELECT latency_per_token_ms, ttfb_ms FROM requests WHERE platform = ? AND model_id = ?').get('openai', 'gpt-4') as any;
    expect(row.latency_per_token_ms).toBe(20); // 2000ms / 100 tokens
    expect(row.ttfb_ms).toBe(300);
  });

  it('handles very fast responses (low latency, high tokens)', () => {
    logRequest('groq', 'llama-fast', 1, 'success', 100, 1000, 1000, null, null, null);
    const row = getDb().prepare('SELECT latency_per_token_ms FROM requests WHERE model_id = ?').get('llama-fast') as any;
    expect(row.latency_per_token_ms).toBe(1); // 1000ms / 1000 tokens = 1ms/token
  });

  it('handles very slow responses (timeout-like penalty)', () => {
    logRequest('groq', 'llama-slow', 1, 'error', 100, 5, 60000, 'timeout', null, null);
    const row = getDb().prepare('SELECT latency_per_token_ms FROM requests WHERE model_id = ?').get('llama-slow') as any;
    expect(row.latency_per_token_ms).toBe(12000); // 60000ms / 5 tokens = 12000ms/token
  });
});

describe('C2: anti-herd buffer-random tiebreak', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    setSetting('bandit_breaker', 'off');
  });

  it('bandit_breaker defaults to off (deterministic behavior)', () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'bandit_breaker'").run();
    expect(getSetting('bandit_breaker')).toBeUndefined();
  });

  it('bandit_breaker can be set to on', () => {
    setSetting('bandit_breaker', 'on');
    expect(getSetting('bandit_breaker')).toBe('on');
  });

  it('bandit_breaker off = today behavior (no random)', () => {
    setSetting('bandit_breaker', 'off');
    expect(getSetting('bandit_breaker')).toBe('off');
  });
});
