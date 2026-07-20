import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../app.js';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { initSecretsStore, _resetCacheForTesting } from '../../middle/redaction/store.js';
import { clearMiddleConfigCache } from '../../middle/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Mock crypto.decrypt so placeholder keys don't fail AES-GCM validation.
vi.mock('../../lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/crypto.js')>();
  return { ...actual, decrypt: vi.fn((_e: string, _i: string, _t: string) => 'mocked-api-key') };
});

let app: Express;
let dashToken: string;
let tempDir: string;

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isGatedApiPath(path)) headers.Cookie = `session=${dashToken}`;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
});

beforeEach(() => {
  tempDir = join(tmpdir(), `middle-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
  _resetCacheForTesting();
  clearMiddleConfigCache();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('B2-7: /api/middle routes', () => {
  describe('GET /api/middle/config', () => {
    it('returns the current config with defaults', async () => {
      const { status, body } = await request(app, 'GET', '/api/middle/config');
      expect(status).toBe(200);
      const config = body as Record<string, string>;
      expect(config.middle_redaction_enabled).toBe('0');
      expect(config.middle_compression_enabled).toBe('0');
      expect(config.middle_interceptor_timeout_ms).toBe('4000');
      expect(config.middle_detection_targets).toBe('["api_key","email","phone","person","address"]');
    });
  });

  describe('PUT /api/middle/config', () => {
    it('updates config and clears the cache', async () => {
      const { status, body } = await request(app, 'PUT', '/api/middle/config', {
        middle_redaction_enabled: '1',
      });
      expect(status).toBe(200);
      expect((body as any).ok).toBe(true);

      const { body: config } = await request(app, 'GET', '/api/middle/config');
      expect((config as any).middle_redaction_enabled).toBe('1');
    });

    it('rejects empty body with 400', async () => {
      const { status } = await request(app, 'PUT', '/api/middle/config', {});
      expect(status).toBe(400);
    });
  });

  describe('POST /api/middle/secrets', () => {
    it('adds a secret and returns its id', async () => {
      const { status, body } = await request(app, 'POST', '/api/middle/secrets', {
        value: 'sk-test-secret-key',
        kind: 'api_key',
        label: 'Test Key',
      });
      expect(status).toBe(200);
      expect((body as any).id).toMatch(/^s_[0-9a-f]{6}$/);
      expect((body as any).ok).toBe(true);
    });

    it('rejects missing value with 400', async () => {
      const { status } = await request(app, 'POST', '/api/middle/secrets', { kind: 'api_key' });
      expect(status).toBe(400);
    });
  });

  describe('GET /api/middle/secrets', () => {
    it('lists secrets metadata without plaintext values', async () => {
      await request(app, 'POST', '/api/middle/secrets', { value: 'sk-test-123', kind: 'api_key', label: 'Test' });
      const { status, body } = await request(app, 'GET', '/api/middle/secrets');
      expect(status).toBe(200);
      const secrets = body as any[];
      expect(secrets.length).toBeGreaterThan(0);
      expect(secrets[0].maskedPreview).toBeDefined();
      expect(JSON.stringify(secrets)).not.toContain('sk-test-123');
    });
  });

  describe('PATCH /api/middle/secrets', () => {
    it('enables/disables a secret by id (query param)', async () => {
      const { body: addBody } = await request(app, 'POST', '/api/middle/secrets', { value: 'sk-patch-test', kind: 'api_key' });
      const id = (addBody as any).id;

      const { status: patchStatus } = await request(app, 'PATCH', `/api/middle/secrets?id=${id}`, { enabled: false });
      expect(patchStatus).toBe(200);

      const { body: secrets } = await request(app, 'GET', '/api/middle/secrets');
      const secret = (secrets as any[]).find(s => s.id === id);
      expect(secret.enabled).toBe(false);
    });

    it('rejects missing id with 400', async () => {
      const { status } = await request(app, 'PATCH', '/api/middle/secrets', { enabled: false });
      expect(status).toBe(400);
    });
  });

  describe('DELETE /api/middle/secrets', () => {
    it('removes a secret by id (query param)', async () => {
      const { body: addBody } = await request(app, 'POST', '/api/middle/secrets', { value: 'sk-delete-test', kind: 'api_key' });
      const id = (addBody as any).id;

      const { status: delStatus } = await request(app, 'DELETE', `/api/middle/secrets?id=${id}`);
      expect(delStatus).toBe(200);

      const { body: secrets } = await request(app, 'GET', '/api/middle/secrets');
      expect((secrets as any[]).find(s => s.id === id)).toBeUndefined();
    });

    it('rejects missing id with 400', async () => {
      const { status } = await request(app, 'DELETE', '/api/middle/secrets');
      expect(status).toBe(400);
    });
  });

  describe('GET /api/middle/stats', () => {
    it('returns interceptor failure count and active secret count', async () => {
      await request(app, 'POST', '/api/middle/secrets', { value: 'sk-stats-test', kind: 'api_key' });
      const { status, body } = await request(app, 'GET', '/api/middle/stats');
      expect(status).toBe(200);
      expect((body as any).interceptor_failures).toBeGreaterThanOrEqual(0);
      expect((body as any).active_secrets).toBeGreaterThanOrEqual(1);
    });
  });
});
