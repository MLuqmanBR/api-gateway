import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setBudget } from '../../services/budgets.js';
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

// Build a real multipart/form-data body around a WAV-shaped payload.
function multipartBody(fields: Record<string, string>, file: { name: string; bytes: number }): FormData {
  const fd = new FormData();
  for (const [name, value] of Object.entries(fields)) fd.append(name, value);
  fd.append('file', new File([new Uint8Array(file.bytes)], file.name, { type: 'audio/wav' }));
  return fd;
}

async function postAudio(
  app: Express,
  path: string,
  key: string,
  fd: FormData,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}
const realFetch = globalThis.fetch;

function okUpstream(text = 'hello from groq', duration = 15) {
  return new Response(JSON.stringify({ text, duration }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Mock only upstream provider calls; the test's own 127.0.0.1 requests
// pass through to the real fetch. Returns a counter of upstream hits.
function withUpstream(responder: () => Response | Promise<Response>): () => number {
  let upstreamCalls = 0;
  const passthrough = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('127.0.0.1')) return realFetch(input, init);
    upstreamCalls++;
    return responder();
  };
  globalThis.fetch = passthrough as unknown as typeof fetch;
  return () => upstreamCalls;
}

describe('/v1/audio routes', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM client_keys').run();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('401s without a key', async () => {
    const upstreamCalls = withUpstream(() => okUpstream());
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', 'no-key', multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 }));
    expect(status).toBe(401);
    expect(body.error.message).toBe('Invalid API key');
    expect(body.error.type).toBe('authentication_error');
    expect(upstreamCalls()).toBe(0);
  });

  it('401s with a wrong key', async () => {
    const { status } = await postAudio(app, '/v1/audio/transcriptions', 'ck_wrong:wrong', multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 }));
    expect(status).toBe(401);
  });

  it('400s when the body is not multipart', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getUnifiedApiKey()}`, 'Content-Type': 'text/plain' },
      body: 'not multipart',
    });
    const data = await res.json().catch(() => null);
    server.close();
    expect(res.status).toBe(400);
    expect(data?.error.message).toBe('multipart/form-data body required');
  });

  it("400s on 'streaming transcription not supported' when stream=true", async () => {
    const fd = multipartBody({ model: 'whisper-large-v3-turbo', stream: 'true' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', getUnifiedApiKey(), fd);
    expect(status).toBe(400);
    expect(body.error.message).toBe('streaming transcription not supported');
  });

  it("400s on 'file field is required' when no file present", async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const fd = new FormData();
    fd.append('model', 'whisper-large-v3-turbo');
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: fd,
    });
    const data = await res.json().catch(() => null);
    server.close();
    expect(res.status).toBe(400);
    expect(data?.error.message).toBe('file field is required');
  });

  it('413s when the file exceeds 25 MB', async () => {
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'huge.wav', bytes: 25 * 1024 * 1024 + 1 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', getUnifiedApiKey(), fd);
    expect(status).toBe(413);
    expect(body.error.message).toBe('File exceeds 25 MB limit');
  });

  it("400s with \"unknown transcription model: 'x'\" for off-catalog models", async () => {
    const fd = multipartBody({ model: 'whisper-tiny' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', getUnifiedApiKey(), fd);
    expect(status).toBe(400);
    expect(body.error.message).toBe("unknown transcription model: 'whisper-tiny'");
  });
  it('unified key without any provider key → 502 (no usable keys)', async () => {
    const upstreamCalls = withUpstream(() => okUpstream());
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', getUnifiedApiKey(), fd);
    expect(status).toBe(502);
    expect(body.error.message).toContain('(no usable keys)');
    expect(upstreamCalls()).toBe(0);
  });

  it('translations gate: turbo → 400 before dispatch', async () => {
    const upstreamCalls = withUpstream(() => okUpstream());
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/translations', getUnifiedApiKey(), fd);
    expect(status).toBe(400);
    expect(body.error.message).toContain('model does not support translation');
    expect(upstreamCalls()).toBe(0);
  });
  it('client key + allowlist not matching → 403 before any upstream call', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'scoped' });
    await request(app, 'PATCH', `/api/keys/client/${minted.body.id}`, { model_allowlist: ['groq/whisper-large-v3'] });
    const upstreamCalls = withUpstream(() => okUpstream());
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', minted.body.key, fd);
    expect(status).toBe(403);
    expect(body.error.message).toBe('transcription error: no transcription models allowed for this client key');
    expect(upstreamCalls()).toBe(0);
  });
  it('client key + allowlist matching → 200 with provider key present', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'scoped' });
    await request(app, 'PATCH', `/api/keys/client/${minted.body.id}`, { model_allowlist: ['groq/whisper-large-v3-turbo'] });
    addKey('groq');
    const upstreamCalls = withUpstream(() => okUpstream());
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', minted.body.key, fd);
    expect(status).toBe(200);
    expect(body.text).toBe('hello from groq');
    expect(upstreamCalls()).toBe(1);
  });

  it('client key with exhausted budget → 402 BEFORE dispatch (zero upstream fetches)', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'capped' });
    // A zero-cent monthly cap: even a 1-cent estimate exceeds it.
    setBudget('client_key', minted.body.id, { monthly_limit_cents: 0 });
    const upstreamCalls = withUpstream(() => okUpstream());
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status, body } = await postAudio(app, '/v1/audio/transcriptions', minted.body.key, fd);
    expect(status).toBe(402);
    expect(body.error.type).toBe('budget_exhausted');
    expect(body.error.period).toBe('monthly');
    expect(upstreamCalls()).toBe(0);
  });

  it('client key with a real budget → 200 and monthly_used_cents advances by actual cost', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'budgeted' });
    setBudget('client_key', minted.body.id, { monthly_limit_cents: 10000 });
    addKey('groq');
    // 60 s actual at $0.04/hr = ceil(60/3600 * 4 cents) = 1 cent
    withUpstream(() => okUpstream('billed text', 60));
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status } = await postAudio(app, '/v1/audio/transcriptions', minted.body.key, fd);
    expect(status).toBe(200);
    const budget = getDb().prepare(
      "SELECT monthly_used_cents FROM budgets WHERE scope = 'client_key' AND scope_id = ?",
    ).get(minted.body.id) as { monthly_used_cents: number };
    expect(budget.monthly_used_cents).toBe(1);
  });

  it('dispatch failure refunds the reservation: monthly_used_cents back to 0', async () => {
    const minted = await request(app, 'POST', '/api/keys/client', { label: 'refunded' });
    setBudget('client_key', minted.body.id, { monthly_limit_cents: 10000 });
    addKey('groq');
    withUpstream(() => new Response('upstream down', { status: 500 }));
    const fd = multipartBody({ model: 'whisper-large-v3-turbo' }, { name: 'clip.wav', bytes: 4096 });
    const { status } = await postAudio(app, '/v1/audio/transcriptions', minted.body.key, fd);
    expect(status).toBe(502);
    const budget = getDb().prepare(
      "SELECT monthly_used_cents FROM budgets WHERE scope = 'client_key' AND scope_id = ?",
    ).get(minted.body.id) as { monthly_used_cents: number } | undefined;
    expect(budget?.monthly_used_cents).toBe(0);
  });

  it('/v1/models stays chat-only — audio models never leak into the list', async () => {
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/models`, {
      headers: { Authorization: `Bearer ${getUnifiedApiKey()}` },
    });
    const data = await res.json();
    server.close();
    const ids: string[] = data.data.map((m: any) => m.id);
    expect(ids).not.toContain('whisper-large-v3-turbo');
    expect(ids).not.toContain('whisper-large-v3');
    expect(ids).not.toContain('voxtral-mini-2602');
  });
});

function addKey(platform: string, raw = `${platform}-test-key`) {
  const { encrypted, iv, authTag } = encrypt(raw);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
}
