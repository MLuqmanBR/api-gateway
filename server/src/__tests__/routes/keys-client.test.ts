import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

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

describe('Client keys API (F3)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM client_keys').run();
  });

  it('GET /api/keys/client returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys/client');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys/client mints a client key with ck_ prefix', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys/client', { label: 'CI pipeline' });
    expect(status).toBe(201);
    expect(body.key).toMatch(/^ck_[a-f0-9]+:[a-f0-9]+$/);
    expect(body.id).toMatch(/^ck_/);
    expect(body.label).toBe('CI pipeline');
  });

  it('GET /api/keys/client lists minted keys without secrets', async () => {
    await request(app, 'POST', '/api/keys/client', { label: 'Test key' });
    const { status, body } = await request(app, 'GET', '/api/keys/client');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].id).toMatch(/^ck_/);
    expect(body[0].label).toBe('Test key');
    expect(body[0].enabled).toBe(1);
    // No secret_hash or salt in the response
    expect(body[0].secret_hash).toBeUndefined();
    expect(body[0].salt).toBeUndefined();
  });

  it('PATCH /api/keys/client/:id disables a key', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'To disable' });
    const { status } = await request(app, 'PATCH', `/api/keys/client/${minted.body.id}`, { enabled: false });
    expect(status).toBe(200);
    const { body } = await request(app, 'GET', '/api/keys/client');
    expect(body[0].enabled).toBe(0);
  });

  it('PATCH /api/keys/client/:id sets model allowlist', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'Scoped' });
    const { status } = await request(app, 'PATCH', `/api/keys/client/${minted.body.id}`, {
      model_allowlist: ['gpt-4o', 'claude-3.5-sonnet'],
    });
    expect(status).toBe(200);
    const { body } = await request(app, 'GET', '/api/keys/client');
    expect(body[0].model_allowlist).toEqual(['gpt-4o', 'claude-3.5-sonnet']);
  });

  it('DELETE /api/keys/client/:id revokes a key', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'To revoke' });
    const { status } = await request(app, 'DELETE', `/api/keys/client/${minted.body.id}`);
    expect(status).toBe(200);
    const { body } = await request(app, 'GET', '/api/keys/client');
    expect(body).toEqual([]);
  });

  it('DELETE /api/keys/client/:id returns 404 for unknown id', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/client/ck_nonexistent');
    expect(status).toBe(404);
  });

  it('POST /api/keys/client rejects empty label', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys/client', { label: '' });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('a minted client key authenticates against /v1/models', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'Auth test' });
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${minted.body.key}` },
    });
    server.close();
    expect(res.status).toBe(200);
  });

  it('a disabled client key is rejected', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'Disabled' });
    await request(app, 'PATCH', `/api/keys/client/${minted.body.id}`, { enabled: false });
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${minted.body.key}` },
    });
    server.close();
    expect(res.status).toBe(401);
  });

  it('a revoked client key is rejected', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'To revoke' });
    await request(app, 'DELETE', `/api/keys/client/${minted.body.id}`);
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${minted.body.key}` },
    });
    server.close();
    expect(res.status).toBe(401);
  });

  it('the unified key still works (backward-compat)', async () => {
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getUnifiedApiKey()}` },
    });
    server.close();
    expect(res.status).toBe(200);
  });

  it('a non-ck_ bearer is not tried as a client key', async () => {
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer some-random-key' },
    });
    server.close();
    expect(res.status).toBe(401);
  });
});
