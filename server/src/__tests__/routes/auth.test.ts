import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// Tests in this file deliberately simulate a REMOTE caller (off the LAN) so
// the dashboard session gate fires the way it would for an off-network
// operator. We opt the test app into trusting `X-Forwarded-For` (single hop)
// and tag every request with a TEST-NET-3 source — that address is in none of
// the trusted ranges, so `requireAuth` falls through to session-token check
// and the auth behavior under test (401, setup, login, logout) is exactly
// what a real off-network caller would see.
const REMOTE_IP = '203.0.113.1'; // RFC 5737 TEST-NET-3 — unrouteable.
const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;

async function call(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Spoof a remote source IP — the server's `requireAuth` honors this
      // because the test app is configured with `trust proxy = 1`.
      'X-Forwarded-For': REMOTE_IP,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// Tests run in definition order against one shared in-memory DB, mirroring the
// real bootstrap sequence: needs-setup → setup → gated access → login → logout.
describe('Dashboard auth (#35)', () => {
  let app: Express;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.TRUST_PROXY = '1'; // let the test app honor X-Forwarded-For.
    initDb(':memory:');
    app = createApp();
  });

  afterAll(() => {
    if (ORIGINAL_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
  });

  it('reports needsSetup before any account exists', async () => {
    const { body } = await call(app, 'GET', '/api/auth/status');
    expect(body).toMatchObject({ needsSetup: true, authenticated: false });
  });

  it('gates /api/* routes with 401 when unauthenticated', async () => {
    expect((await call(app, 'GET', '/api/keys')).status).toBe(401);
    expect((await call(app, 'GET', '/api/fallback')).status).toBe(401);
    expect((await call(app, 'GET', '/api/settings/api-key')).status).toBe(401);
  });

  it('leaves /api/ping and the /v1 proxy reachable without a dashboard session', async () => {
    expect((await call(app, 'GET', '/api/ping')).status).toBe(200);
    // /v1 has its own (unified-key) auth, so it 401s for a different reason —
    // the point is it is not gated by the dashboard session middleware.
    const proxy = await call(app, 'POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] });
    expect(proxy.body.error.type).toBe('authentication_error');
  });

  it('rejects weak setup credentials', async () => {
    expect((await call(app, 'POST', '/api/auth/setup', { email: 'bad', password: 'x' })).status).toBe(400);
    expect((await call(app, 'POST', '/api/auth/setup', { email: 'a@b.com', password: 'short' })).status).toBe(400);
  });

  let token = '';
  it('creates the first account on setup and returns a working token', async () => {
    const { status, body } = await call(app, 'POST', '/api/auth/setup', { email: 'admin@example.com', password: 'supersecret' });
    expect(status).toBe(201);
    expect(typeof body.token).toBe('string');
    token = body.token;
    expect((await call(app, 'GET', '/api/keys', undefined, token)).status).toBe(200);
  });

  it('refuses a second setup once an account exists', async () => {
    const { status } = await call(app, 'POST', '/api/auth/setup', { email: 'second@example.com', password: 'supersecret' });
    expect(status).toBe(409);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const ok = await call(app, 'POST', '/api/auth/login', { email: 'admin@example.com', password: 'supersecret' });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');

    const bad = await call(app, 'POST', '/api/auth/login', { email: 'admin@example.com', password: 'wrongpassword' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.type).toBe('authentication_error');
  });

  it('reports authenticated status with a valid token', async () => {
    const { body } = await call(app, 'GET', '/api/auth/status', undefined, token);
    expect(body).toMatchObject({ needsSetup: false, authenticated: true, email: 'admin@example.com' });
  });

  it('invalidates the token on logout', async () => {
    const login = await call(app, 'POST', '/api/auth/login', { email: 'admin@example.com', password: 'supersecret' });
    const t = login.body.token;
    expect((await call(app, 'GET', '/api/keys', undefined, t)).status).toBe(200);
    await call(app, 'POST', '/api/auth/logout', {}, t);
    expect((await call(app, 'GET', '/api/keys', undefined, t)).status).toBe(401);
  });

  it('locks out after repeated failed attempts (separate email, no real account)', async () => {
    const creds = { email: 'attacker@example.com', password: 'guessguess' };
    for (let i = 0; i < 5; i++) {
      expect((await call(app, 'POST', '/api/auth/login', creds)).status).toBe(401);
    }
    expect((await call(app, 'POST', '/api/auth/login', creds)).status).toBe(429);
  });
});

// ── HttpOnly session cookie (Improvement 1) ────────────────────────────────
// setup/login also set an HttpOnly session cookie alongside the JSON token;
// requireAuth accepts it as an alternative to the bearer header; logout clears
// it. Same remote-caller simulation as above so the LAN auto-grant never fires.
describe('Session cookie (Improvement 1)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.TRUST_PROXY = '1';
    initDb(':memory:'); // fresh DB — this describe re-runs the setup flow.
    app = createApp();
  });

  afterAll(() => {
    if (ORIGINAL_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = ORIGINAL_TRUST_PROXY;
  });

  // Like `call` above, but exposes response headers (Set-Cookie) and lets the
  // caller attach arbitrary request headers (Cookie) instead of a bearer.
  async function callRaw(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-Forwarded-For': REMOTE_IP,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data, setCookie: res.headers.get('set-cookie') };
  }

  let cookiePair = ''; // "api-gateway_session=<token>" captured from login

  it('setup and login both set an HttpOnly SameSite=Lax Path=/api cookie carrying the token', async () => {
    const setup = await callRaw('POST', '/api/auth/setup', { email: 'admin@example.com', password: 'supersecret' });
    expect(setup.status).toBe(201);
    expect(setup.setCookie).toBeTruthy();

    const login = await callRaw('POST', '/api/auth/login', { email: 'admin@example.com', password: 'supersecret' });
    expect(login.status).toBe(200);

    for (const sc of [setup.setCookie!, login.setCookie!]) {
      expect(sc).toMatch(/^api-gateway_session=[0-9a-f]{64};/);
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/SameSite=Lax/i);
      expect(sc).toMatch(/Path=\/api/i);
      expect(sc).toMatch(/Max-Age=2592000/i); // 30 days — matches SESSION_TTL_MS
      // Plain-HTTP request → no Secure attribute, or the browser would drop
      // the cookie on the normal LAN deployment.
      expect(sc).not.toMatch(/Secure/i);
    }
    // Cookie value is the same session token returned in the JSON body.
    expect(login.setCookie).toContain(`api-gateway_session=${login.body.token};`);
    cookiePair = `api-gateway_session=${login.body.token}`;
  });

  it('grants a protected /api route with ONLY the cookie (no Authorization header)', async () => {
    const { status } = await callRaw('GET', '/api/keys', undefined, { Cookie: cookiePair });
    expect(status).toBe(200);
  });

  it('still 401s with no credentials, and rejects a garbage cookie', async () => {
    expect((await callRaw('GET', '/api/keys')).status).toBe(401);
    expect((await callRaw('GET', '/api/keys', undefined, { Cookie: 'api-gateway_session=deadbeef' })).status).toBe(401);
  });

  it('authenticates the /api/events SSE stream with the cookie alone', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/events`, {
      headers: { 'X-Forwarded-For': REMOTE_IP, Cookie: cookiePair },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    controller.abort(); // don't wait on the endless stream
    server.close();

    // …and still 401s without any credential (ticket path unaffected).
    const denied = await callRaw('GET', '/api/events');
    expect(denied.status).toBe(401);
  });

  it('clears the cookie on logout and invalidates the session it carried', async () => {
    const login = await callRaw('POST', '/api/auth/login', { email: 'admin@example.com', password: 'supersecret' });
    const pair = `api-gateway_session=${login.body.token}`;
    expect((await callRaw('GET', '/api/keys', undefined, { Cookie: pair })).status).toBe(200);

    // Logout authenticated by the cookie itself — no bearer.
    const out = await callRaw('POST', '/api/auth/logout', {}, { Cookie: pair });
    expect(out.status).toBe(200);
    // Clearing Set-Cookie: empty value + Path=/api + an epoch expiry.
    expect(out.setCookie).toMatch(/^api-gateway_session=;/);
    expect(out.setCookie).toMatch(/Path=\/api/i);
    expect(out.setCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);

    // The session is gone server-side, so replaying the old cookie fails.
    expect((await callRaw('GET', '/api/keys', undefined, { Cookie: pair })).status).toBe(401);
  });
});
