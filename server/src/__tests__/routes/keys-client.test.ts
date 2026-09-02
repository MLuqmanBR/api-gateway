import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { migrateDbSchema } from '../../db/migrations.js';
import { isModelAllowed } from '../../lib/client-keys.js';
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

describe('isModelAllowed (strict qualified matching)', () => {
  it('a qualified entry matches its exact platform only', () => {
    expect(isModelAllowed(['aggregatore/kimi-k3'], 'aggregatore', 'kimi-k3')).toBe(true);
    expect(isModelAllowed(['aggregatore/kimi-k3'], 'aggregatorf', 'kimi-k3')).toBe(false);
  });

  it('a bare entry admits nothing', () => {
    expect(isModelAllowed(['kimi-k3'], 'aggregatore', 'kimi-k3')).toBe(false);
    expect(isModelAllowed(['kimi-k3'], 'nvidia', 'moonshotai/kimi-k3')).toBe(false);
  });

  it('a qualified entry does not match a different model on the same platform', () => {
    expect(isModelAllowed(['aggregatore/deepseek-v4-pro'], 'aggregatore', 'deepseek-v4-flash')).toBe(false);
  });
});

describe('client key allowlist normalization (bare → qualified)', () => {
  const MODEL_COLS = '(platform, model_id, display_name, intelligence_rank, speed_rank)';

  function insertModel(platform: string, modelId: string) {
    getDb().prepare(
      `INSERT INTO models ${MODEL_COLS} VALUES (?, ?, ?, 1, 1)`,
    ).run(platform, modelId, modelId);
  }

  function insertKey(id: string, allowlistJson: string) {
    getDb().prepare(
      `INSERT INTO client_keys (id, secret_hash, salt, label, enabled, model_allowlist, created_at_ms)
       VALUES (?, 'x', 'y', ?, 1, ?, ?)`,
    ).run(id, id, allowlistJson, Date.now());
  }

  function allowlistOf(id: string): string | null {
    return (getDb().prepare('SELECT model_allowlist FROM client_keys WHERE id = ?').get(id) as { model_allowlist: string | null }).model_allowlist;
  }
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM client_keys').run();
    db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform IN (?, ?))').run('normp1', 'normp2');
    db.prepare("DELETE FROM models WHERE platform IN ('normp1', 'normp2')").run();
    // normp1 + normp2 both serve bare 'shared-model'; only normp1 serves 'qualified-model'.
    insertModel('normp1', 'shared-model');
    insertModel('normp2', 'shared-model');
    insertModel('normp1', 'qualified-model');
  });
  afterEach(() => {
    getDb().prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform IN (?, ?))').run('normp1', 'normp2');
    getDb().prepare("DELETE FROM models WHERE platform IN ('normp1', 'normp2')").run();
    getDb().prepare('DELETE FROM client_keys').run();
  });

  it('expands a bare entry to every platform serving that name and preserves qualified entries', () => {
    insertKey('k1', JSON.stringify(['shared-model', 'normp1/qualified-model']));
    migrateDbSchema(getDb());
    expect(JSON.parse(allowlistOf('k1')!)).toEqual([
      'normp1/shared-model',
      'normp2/shared-model',
      'normp1/qualified-model',
    ]);
  });

  it('keeps an entry that LOOKS qualified but is actually a bare id with a slash', () => {
    // 'slashed/model' is a BARE model_id served by normp2 — the qualified-pair
    // check must not eat it; expansion must target the real platforms.
    insertModel('normp2', 'slashed/model');
    insertKey('k2', JSON.stringify(['slashed/model']));
    migrateDbSchema(getDb());
    expect(JSON.parse(allowlistOf('k2')!)).toEqual(['normp2/slashed/model']);
  });

  it('drops entries matching no models row at all', () => {
    insertKey('k3', JSON.stringify(['no-such-model-anywhere']));
    migrateDbSchema(getDb());
    expect(JSON.parse(allowlistOf('k3')!)).toEqual([]);
  });

  it('is idempotent — second run leaves values byte-identical', () => {
    insertKey('k4', JSON.stringify(['shared-model', 'normp1/qualified-model']));
    migrateDbSchema(getDb());
    const once = allowlistOf('k4');
    migrateDbSchema(getDb());
    expect(allowlistOf('k4')).toBe(once);
  });

  it('preserves a qualified audio entry — transcription_models union hit', () => {
    // The transcription seed rows exist from the migration; the entry is a
    // qualified pair for a transcription_models row, not a chat models row.
    insertKey('k5', JSON.stringify(['groq/whisper-large-v3-turbo']));
    migrateDbSchema(getDb());
    expect(JSON.parse(allowlistOf('k5')!)).toEqual(['groq/whisper-large-v3-turbo']);
  });

  it('expands a bare audio id to its transcription platform', () => {
    // Bare 'whisper-large-v3' exists ONLY in transcription_models (groq).
    insertKey('k6', JSON.stringify(['whisper-large-v3']));
    migrateDbSchema(getDb());
    expect(JSON.parse(allowlistOf('k6')!)).toEqual(['groq/whisper-large-v3']);
  });
});
