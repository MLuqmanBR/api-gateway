import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import {
  acquireSlot,
  isQueueEnabled,
  getQueueStats,
  resetSemaphores,
  QueueTimeoutError,
} from '../../services/queue.js';
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
  return { status: res.status, body: data, headers: res.headers };
}

describe('Queue + concurrency caps (F9)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    resetSemaphores();
    setSetting('max_concurrency_per_provider', '0');
    setSetting('queue_timeout_ms', '2000');
    setSetting('max_queue_size', '100');
  });

  describe('service', () => {
    it('isQueueEnabled returns false when max_concurrency is 0', () => {
      setSetting('max_concurrency_per_provider', '0');
      expect(isQueueEnabled()).toBe(false);
    });

    it('isQueueEnabled returns true when max_concurrency > 0', () => {
      setSetting('max_concurrency_per_provider', '5');
      expect(isQueueEnabled()).toBe(true);
    });

    it('acquireSlot returns release function when unlimited', async () => {
      setSetting('max_concurrency_per_provider', '0');
      const release = await acquireSlot('groq');
      expect(typeof release).toBe('function');
      release();
    });

    it('acquireSlot blocks when at max concurrency', async () => {
      setSetting('max_concurrency_per_provider', '1');
      setSetting('queue_timeout_ms', '100');
      const release1 = await acquireSlot('groq');
      // Second acquire should timeout (100ms)
      await expect(acquireSlot('groq')).rejects.toThrow();
      release1();
    });

    it('acquireSlot times out with QueueTimeoutError', async () => {
      setSetting('max_concurrency_per_provider', '1');
      setSetting('queue_timeout_ms', '50');
      const release1 = await acquireSlot('openai');
      try {
        await expect(acquireSlot('openai')).rejects.toThrow('after 50ms');
        await expect(acquireSlot('openai')).rejects.toBeInstanceOf(QueueTimeoutError);
      } finally {
        release1();
      }
    });

    it('acquireSlot rejects immediately when queue is full (reject strategy)', async () => {
      setSetting('max_concurrency_per_provider', '1');
      setSetting('max_queue_size', '1');
      setSetting('queue_timeout_ms', '5000');
      const release1 = await acquireSlot('mistral');
      // Fill the queue
      const waiterPromise = acquireSlot('mistral'); // this one waits in queue
      // Third acquire should reject immediately (queue full)
      await expect(acquireSlot('mistral')).rejects.toThrow('queue_full');
      release1();
      // Let the waiter resolve
      const release2 = await waiterPromise;
      release2();
    });

    it('released slot wakes FIFO waiter', async () => {
      setSetting('max_concurrency_per_provider', '1');
      setSetting('queue_timeout_ms', '5000');
      const release1 = await acquireSlot('perplexity');
      // Start a waiter
      const waiterPromise = acquireSlot('perplexity');
      // Release after a short delay
      setTimeout(() => release1(), 50);
      // The waiter should eventually get the slot
      const release2 = await waiterPromise;
      expect(typeof release2).toBe('function');
      release2();
    });

    it('getQueueStats reports active and queued counts', async () => {
      setSetting('max_concurrency_per_provider', '2');
      const r1 = await acquireSlot('deepseek');
      const r2 = await acquireSlot('deepseek');
      const stats = getQueueStats();
      const deepseekStats = stats.find(s => s.platform === 'deepseek');
      expect(deepseekStats?.active).toBe(2);
      expect(deepseekStats?.queued).toBe(0);
      r1();
      r2();
    });

    it('per-provider semaphores are independent', async () => {
      setSetting('max_concurrency_per_provider', '1');
      const r1 = await acquireSlot('groq');
      // Different provider should not be blocked
      const r2 = await acquireSlot('openai');
      expect(typeof r2).toBe('function');
      r1();
      r2();
    });
  });

  describe('API route', () => {
    it('GET /api/queue returns enabled flag + stats', async () => {
      const res = await request(app, 'GET', '/api/queue');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false); // disabled by default
      expect(Array.isArray(res.body.stats)).toBe(true);
    });
  });
});
