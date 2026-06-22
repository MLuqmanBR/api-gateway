import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers)
        ? { Authorization: `Bearer ${dashToken}` }
        : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  server.close();
  let json: unknown = null;
  try {
    json = JSON.parse(data);
  } catch {
    /* non-JSON body, leave json null */
  }
  return { status: res.status, body: json, headers: Object.fromEntries(res.headers) };
}

describe('built-in platform settings (/api/platforms/:platform/settings)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    // Reset the built-in platform settings to seeded defaults.
    getDb().prepare(
      `UPDATE built_in_provider_settings
         SET rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL, tpd_limit = NULL,
             sticky_sessions_enabled = 0`,
    ).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET returns the seeded defaults for a built-in platform', async () => {
    const res = await request(app, 'GET', '/api/platforms/groq/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      platform: 'groq',
      rpmLimit: null,
      rpdLimit: null,
      tpmLimit: null,
      tpdLimit: null,
      stickySessionsEnabled: false,
    });
  });

  it('GET on an unknown platform returns 404', async () => {
    const res = await request(app, 'GET', '/api/platforms/nonexistent-platform/settings');
    expect(res.status).toBe(404);
  });

  it('PATCH persists the supplied fields and returns the updated row', async () => {
    const patch = await request(app, 'PATCH', '/api/platforms/groq/settings', {
      rpmLimit: 60,
      rpdLimit: 14400,
      stickySessionsEnabled: true,
    });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({
      platform: 'groq',
      rpmLimit: 60,
      rpdLimit: 14400,
      tpmLimit: null,
      tpdLimit: null,
      stickySessionsEnabled: true,
    });

    // The follow-up GET reflects the same state.
    const get = await request(app, 'GET', '/api/platforms/groq/settings');
    expect(get.status).toBe(200);
    expect(get.body).toEqual(patch.body);
  });

  it('PATCH with no fields returns 400', async () => {
    const res = await request(app, 'PATCH', '/api/platforms/groq/settings', {});
    expect(res.status).toBe(400);
  });

  it('PATCH on an unknown platform returns 404', async () => {
    const res = await request(app, 'PATCH', '/api/platforms/nonexistent-platform/settings', {
      rpmLimit: 10,
    });
    expect(res.status).toBe(404);
  });

  it('PATCH with invalid rpmLimit (negative) returns 400', async () => {
    const res = await request(app, 'PATCH', '/api/platforms/groq/settings', {
      rpmLimit: -1,
    });
    expect(res.status).toBe(400);
  });
});