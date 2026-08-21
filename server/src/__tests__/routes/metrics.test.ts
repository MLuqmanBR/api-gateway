import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import {
  recordMetricsRequest,
  recordMetricsTokens,
  getMetricsText,
  isMetricsAuthEnabled,
  verifyMetricsToken,
} from '../../services/metrics.js';

describe('Prometheus /metrics (F7)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  describe('metrics service', () => {
    it('recordMetricsRequest increments the request counter', async () => {
      recordMetricsRequest({ platform: 'groq', model: 'llama', status: 'success', stream: true, latencyMs: 100 });
      const text = await getMetricsText();
      expect(text).toContain('api_gateway_requests_total');
      expect(text).toContain('platform="groq"');
      expect(text).toContain('model="llama"');
      expect(text).toContain('status="success"');
      expect(text).toContain('stream="true"');
    });

    it('recordMetricsRequest records latency in histogram', async () => {
      recordMetricsRequest({ platform: 'groq', model: 'test', status: 'success', stream: false, latencyMs: 250 });
      const text = await getMetricsText();
      expect(text).toContain('api_gateway_request_duration_ms');
      expect(text).toContain('api_gateway_request_duration_ms_bucket');
    });

    it('recordMetricsTokens increments token counter', async () => {
      recordMetricsTokens({ platform: 'groq', model: 'test', inputTokens: 100, outputTokens: 50 });
      const text = await getMetricsText();
      expect(text).toContain('api_gateway_tokens_total');
      expect(text).toContain('direction="input"');
      expect(text).toContain('direction="output"');
    });
  });

  describe('auth', () => {
    it('isMetricsAuthEnabled returns false when METRICS_AUTH_TOKEN is unset', () => {
      const saved = process.env.METRICS_AUTH_TOKEN;
      delete process.env.METRICS_AUTH_TOKEN;
      expect(isMetricsAuthEnabled()).toBe(false);
      if (saved) process.env.METRICS_AUTH_TOKEN = saved;
    });

    it('isMetricsAuthEnabled returns true when METRICS_AUTH_TOKEN is set', () => {
      process.env.METRICS_AUTH_TOKEN = 'test-token';
      expect(isMetricsAuthEnabled()).toBe(true);
      delete process.env.METRICS_AUTH_TOKEN;
    });

    it('verifyMetricsToken rejects wrong token', () => {
      process.env.METRICS_AUTH_TOKEN = 'correct-token';
      expect(verifyMetricsToken('wrong-token')).toBe(false);
      expect(verifyMetricsToken('correct-token')).toBe(true);
      expect(verifyMetricsToken(undefined)).toBe(false);
      delete process.env.METRICS_AUTH_TOKEN;
    });

    it('verifyMetricsToken fails closed when token not configured', () => {
      delete process.env.METRICS_AUTH_TOKEN;
      expect(verifyMetricsToken('any-token')).toBe(false);
    });
  });

  describe('GET /metrics route', () => {
    it('returns 401 when METRICS_AUTH_TOKEN not configured', async () => {
      const saved = process.env.METRICS_AUTH_TOKEN;
      delete process.env.METRICS_AUTH_TOKEN;
      const server = app.listen(0);
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      server.close();
      expect(res.status).toBe(401);
      if (saved) process.env.METRICS_AUTH_TOKEN = saved;
    });

    it('returns 401 with wrong token', async () => {
      process.env.METRICS_AUTH_TOKEN = 'secret';
      const server = app.listen(0);
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      server.close();
      expect(res.status).toBe(401);
      delete process.env.METRICS_AUTH_TOKEN;
    });

    it('returns metrics text with correct token', async () => {
      process.env.METRICS_AUTH_TOKEN = 'secret';
      const server = app.listen(0);
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`, {
        headers: { Authorization: 'Bearer secret' },
      });
      const text = await res.text();
      server.close();
      expect(res.status).toBe(200);
      expect(text).toContain('api_gateway_requests_total');
      delete process.env.METRICS_AUTH_TOKEN;
    });

    it('accepts token via query param', async () => {
      process.env.METRICS_AUTH_TOKEN = 'query-secret';
      const server = app.listen(0);
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics?token=query-secret`);
      server.close();
      expect(res.status).toBe(200);
      delete process.env.METRICS_AUTH_TOKEN;
    });
  });
});
