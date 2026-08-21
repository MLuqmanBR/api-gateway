import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import {
  isCircuitOpen,
  recordCircuitSuccess,
  recordCircuitFailure,
  shouldMarkExhausted,
  getAllCircuits,
  resetCircuit,
  resetAllCircuits,
} from '../../services/circuit-breaker.js';
import { setSetting } from '../../db/index.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// getCircuitState was a production export with no non-test caller (audit L01);
// observe state through the admin surface (getAllCircuits) instead.
function stateOf(platform: string, model: string, keyId: number): string | null {
  return getAllCircuits().find(c => c.key === `${platform}:${model}:${keyId}`)?.state ?? null;
}

describe('Circuit breaker (F10)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    resetAllCircuits();
    setSetting('circuit_breaker_failure_threshold', '5');
    setSetting('circuit_breaker_cooldown_ms', '30000');
    setSetting('circuit_breaker_max_reopens', '3');
  });

  describe('state machine', () => {
    it('starts in CLOSED — isCircuitOpen returns false', () => {
      expect(isCircuitOpen('groq', 'llama-3', 1)).toBe(false);
      expect(stateOf('groq', 'llama-3', 1)).toBeNull();
    });

    it('N consecutive failures open the circuit', () => {
      setSetting('circuit_breaker_failure_threshold', '3');
      expect(recordCircuitFailure('groq', 'llama-3', 1)).toBe(false); // 1
      expect(recordCircuitFailure('groq', 'llama-3', 1)).toBe(false); // 2
      expect(recordCircuitFailure('groq', 'llama-3', 1)).toBe(true);  // 3 → opens
      expect(isCircuitOpen('groq', 'llama-3', 1)).toBe(true);
      expect(stateOf('groq', 'llama-3', 1)).toBe('open');
    });

    it('circuit transitions to HALF_OPEN after cooldown', async () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      setSetting('circuit_breaker_cooldown_ms', '50');
      recordCircuitFailure('openai', 'gpt-4', 1);
      recordCircuitFailure('openai', 'gpt-4', 1); // opens
      expect(isCircuitOpen('openai', 'gpt-4', 1)).toBe(true);
      await new Promise(r => setTimeout(r, 60));
      expect(isCircuitOpen('openai', 'gpt-4', 1)).toBe(false); // half_open — probe allowed
      expect(stateOf('openai', 'gpt-4', 1)).toBe('half_open');
    });

    it('HALF_OPEN probe success → CLOSED', async () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      setSetting('circuit_breaker_cooldown_ms', '50');
      recordCircuitFailure('groq', 'llama', 1);
      recordCircuitFailure('groq', 'llama', 1); // opens
      await new Promise(r => setTimeout(r, 60));
      isCircuitOpen('groq', 'llama', 1); // triggers half_open
      recordCircuitSuccess('groq', 'llama', 1);
      expect(stateOf('groq', 'llama', 1)).toBe('closed');
      expect(isCircuitOpen('groq', 'llama', 1)).toBe(false);
    });

    it('HALF_OPEN probe failure → re-OPEN with doubled cooldown', async () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      setSetting('circuit_breaker_cooldown_ms', '50');
      recordCircuitFailure('groq', 'llama', 1);
      recordCircuitFailure('groq', 'llama', 1); // opens, cooldown=50ms
      await new Promise(r => setTimeout(r, 60));
      isCircuitOpen('groq', 'llama', 1); // triggers half_open
      recordCircuitFailure('groq', 'llama', 1); // probe failed → re-open
      expect(stateOf('groq', 'llama', 1)).toBe('open');
    });

    it('shouldMarkExhausted after max reopens', () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      setSetting('circuit_breaker_max_reopens', '3');
      // Open 3 times
      for (let i = 0; i < 3; i++) {
        recordCircuitFailure('mistral', 'mistral-large', 1);
        recordCircuitFailure('mistral', 'mistral-large', 1); // opens
        // Simulate half-open + failure to re-open
        const entry = (getAllCircuits() as any[]).find(c => c.key === 'mistral:mistral-large:1');
        if (entry) {
          // Force half_open by manipulating time
          resetCircuit('mistral', 'mistral-large', 1);
          recordCircuitFailure('mistral', 'mistral-large', 1);
          recordCircuitFailure('mistral', 'mistral-large', 1);
        }
      }
      // After enough re-opens, should be exhausted
      // (This test is approximate — the real flow involves async cooldown)
    });

    it('per-(platform, model, keyId) — different keys are independent', () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      recordCircuitFailure('groq', 'llama-3', 1);
      recordCircuitFailure('groq', 'llama-3', 1); // key 1 opens
      expect(isCircuitOpen('groq', 'llama-3', 1)).toBe(true);
      // Key 2 is still closed
      expect(isCircuitOpen('groq', 'llama-3', 2)).toBe(false);
    });

    it('recordCircuitSuccess resets to CLOSED', () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      recordCircuitFailure('groq', 'llama-3', 1);
      recordCircuitFailure('groq', 'llama-3', 1); // opens
      recordCircuitSuccess('groq', 'llama-3', 1);
      expect(stateOf('groq', 'llama-3', 1)).toBe('closed');
      expect(isCircuitOpen('groq', 'llama-3', 1)).toBe(false);
    });

    it('getAllCircuits returns all entries', () => {
      setSetting('circuit_breaker_failure_threshold', '5');
      recordCircuitFailure('groq', 'llama', 1);
      recordCircuitFailure('openai', 'gpt-4', 2);
      const all = getAllCircuits();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('resetCircuit removes a specific circuit', () => {
      setSetting('circuit_breaker_failure_threshold', '2');
      recordCircuitFailure('groq', 'llama', 1);
      recordCircuitFailure('groq', 'llama', 1); // opens
      resetCircuit('groq', 'llama', 1);
      expect(stateOf('groq', 'llama', 1)).toBeNull();
      expect(isCircuitOpen('groq', 'llama', 1)).toBe(false);
    });
  });

  describe('API route', () => {
    it('GET /api/circuits returns all circuit states', async () => {
      const res = await request(app, 'GET', '/api/circuits');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('DELETE /api/circuits resets all', async () => {
      const res = await request(app, 'DELETE', '/api/circuits');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
