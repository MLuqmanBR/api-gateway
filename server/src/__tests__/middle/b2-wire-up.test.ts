import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { resolvePinnedModel } from '../../lib/pinned-model.js';
import { initSecretsStore, addSecret, _resetCacheForTesting } from '../../middle/redaction/store.js';
import { clearMiddleConfigCache } from '../../middle/index.js';

// Mock routeRequest so we don't need real provider keys.
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

// Mock crypto.decrypt so placeholder keys don't fail AES-GCM validation.
vi.mock('../../lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/crypto.js')>();
  return { ...actual, decrypt: vi.fn((_e: string, _i: string, _t: string) => 'mocked-api-key') };
});

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model', release: () => {} };
}

async function request(app: Express, path: string, body: Record<string, unknown>, key: string) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function frames(text: string): Record<string, unknown>[] {
  return text.split('\n')
    .filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
    .map(l => JSON.parse(l.slice(6)));
}

const SECRET = 'sk-test-secret-key-1234567890';
let tempDir: string;
let app: Express;
let key: string;
let capturedMessages: any[] | null = null;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  key = getUnifiedApiKey();
});

beforeEach(() => {
  tempDir = join(tmpdir(), `middle-b26-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
  _resetCacheForTesting();
  clearMiddleConfigCache();
  capturedMessages = null;

  // Add a known secret to the store
  addSecret(SECRET, 'api_key', 'manual', 'Test API Key');

  const db = getDb();
  // Seed a model + key so routeRequest can find a healthy target
  db.prepare("DELETE FROM api_keys WHERE platform='fake'").run();
  db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('fake', 'test', 'enc', 'iv', 'tag', 'healthy', 1)").run();
  db.prepare("INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled) VALUES (9999, 'fake', 'fake-model', 'Fake Model', 5, 5, 'Small', 1) ON CONFLICT(id) DO UPDATE SET platform='fake', model_id='fake-model', enabled=1").run();
  // M47: a missing seed row must FAIL the suite, not log and continue.
  const checkModel = db.prepare("SELECT id, model_id, enabled FROM models WHERE model_id = 'fake-model'").get();
  expect(checkModel).toBeDefined();
});

afterEach(() => {
  setSetting('middle_redaction_enabled', '0');
  clearMiddleConfigCache();
  _resetCacheForTesting();
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Disabled-path byte-identity ────────────────────────────────────────────

describe('B2-6: disabled-path byte-identity', () => {
  it('non-stream /v1/chat/completions: output is byte-identical with redaction off', async () => {
    const responseText = 'Hello, world!';
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
      },
      async *streamChatCompletion() { throw new Error('should not be called'); },
      validateKey: vi.fn(), platform: 'fake', name: 'Fake', baseUrl: 'http://fake',
    } as any));

    // Redaction OFF
    clearMiddleConfigCache();

    const { status, body } = await request(app, '/v1/chat/completions', {
      model: 'fake-model', messages: [{ role: 'user', content: `My key is ${SECRET}` }], stream: false,
    }, key);
    expect(status).toBe(200);
    expect((body as any).choices[0].message.content).toBe(responseText);
    // Redaction was off → provider received the original (un-redacted) text
    expect(capturedMessages).toBeTruthy();
    const userOutboundOff = capturedMessages!.find((m: any) => m.role !== 'system');
    expect(userOutboundOff?.content).toContain(SECRET);
  });
});

// ── Enabled round-trip: /v1/chat/completions ───────────────────────────────

describe('B2-6: enabled round-trip /v1/chat/completions', () => {
  it('non-stream: secret redacted → provider sees placeholder → client sees real value', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        // Echo the placeholder back in the response — find first non-system message (redaction instruction may be at [0])
        const userMsg = messages.find((m: any) => m.role !== 'system');
        const text = userMsg?.content as string;
        return { choices: [{ message: { role: 'assistant', content: `I see your key: ${text.match(/⟦R\d+:[0-9a-f]+⟧/)?.[0] ?? text}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
      },
      async *streamChatCompletion() { throw new Error('should not be called'); },
      validateKey: vi.fn(), platform: 'fake', name: 'Fake', baseUrl: 'http://fake',
    } as any));

    setSetting('middle_redaction_enabled', '1');
    clearMiddleConfigCache();

    const { status, body } = await request(app, '/v1/chat/completions', {
      model: 'fake-model', messages: [{ role: 'user', content: `My key is ${SECRET}` }], stream: false,
    }, key);
    expect(status).toBe(200);
    // Provider received the placeholder, NOT the real secret
    expect(capturedMessages).toBeTruthy();
    const userOutbound = capturedMessages!.find((m: any) => m.role !== 'system');
    expect(userOutbound?.content).not.toContain(SECRET);
    expect(userOutbound?.content).toMatch(/⟦R\d+:[0-9a-f]+⟧/);
    // Client received the real value (un-redacted)
    const responseContent = (body as any).choices[0].message.content;
    expect(responseContent).toContain(SECRET);
    expect(responseContent).not.toMatch(/⟦R\d+:[0-9a-f]+⟧/);
  });

  it('stream: secret redacted → provider sees placeholder → client sees real value', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('should not be called'); },
      async *streamChatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        const userMsg = messages.find((m: any) => m.role !== 'system');
        const placeholder = (userMsg?.content as string).match(/⟦R\d+:[0-9a-f]+⟧/)?.[0] ?? 'unknown';
        // Stream the placeholder split across two chunks
        const mid = Math.floor(placeholder.length / 2);
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: `Key: ${placeholder.slice(0, mid)}` }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: `${placeholder.slice(mid)} end` }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      },
      validateKey: vi.fn(), platform: 'fake', name: 'Fake', baseUrl: 'http://fake',
    } as any));

    setSetting('middle_redaction_enabled', '1');
    clearMiddleConfigCache();

    const { status, text } = await request(app, '/v1/chat/completions', {
      model: 'fake-model', messages: [{ role: 'user', content: `My key is ${SECRET}` }], stream: true,
    }, key);
    expect(status).toBe(200);
    // Provider received the placeholder
    const userOutboundStream = capturedMessages!.find((m: any) => m.role !== 'system');
    expect(userOutboundStream?.content).not.toContain(SECRET);
    expect(userOutboundStream?.content).toMatch(/⟦R\d+:[0-9a-f]+⟧/);
    // Client received the real value (un-redacted from split chunks)
    const allFrames = frames(text);
    const contentChunks = allFrames
      .filter(f => (f as any).choices?.[0]?.delta?.content)
      .map(f => (f as any).choices[0].delta.content)
      .join('');
    expect(contentChunks).toContain(SECRET);
    expect(contentChunks).not.toMatch(/⟦R\d+:[0-9a-f]+⟧/);
  });

  it('non-stream: tool-call args with secret are un-redacted', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        const userMsg = messages.find((m: any) => m.role !== 'system');
        const placeholder = (userMsg?.content as string).match(/⟦R\d+:[0-9a-f]+⟧/)?.[0] ?? 'unknown';
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save_key', arguments: JSON.stringify({ key: placeholder }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
      },
      async *streamChatCompletion() { throw new Error('should not be called'); },
      validateKey: vi.fn(), platform: 'fake', name: 'Fake', baseUrl: 'http://fake',
    } as any));

    setSetting('middle_redaction_enabled', '1');
    clearMiddleConfigCache();

    const { status, body } = await request(app, '/v1/chat/completions', {
      model: 'fake-model', messages: [{ role: 'user', content: `Save this: ${SECRET}` }], stream: false,
    }, key);
    expect(status).toBe(200);
    // Client received the real value in tool-call args
    const args = (body as any).choices[0].message.tool_calls[0].function.arguments;
    expect(JSON.parse(args).key).toBe(SECRET);
  });
});

// ── Enabled round-trip: /v1/responses ────────────────────────────────────────

describe('B2-6: enabled round-trip /v1/responses', () => {
  it('non-stream: secret redacted → provider sees placeholder → client sees real value', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        const userMsg = messages.find((m: any) => m.role !== 'system');
        const placeholder = (userMsg?.content as string).match(/⟦R\d+:[0-9a-f]+⟧/)?.[0] ?? 'unknown';
        return { choices: [{ message: { role: 'assistant', content: `Key: ${placeholder}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
      },
      async *streamChatCompletion() { throw new Error('should not be called'); },
      validateKey: vi.fn(), platform: 'fake', name: 'Fake', baseUrl: 'http://fake',
    } as any));

    setSetting('middle_redaction_enabled', '1');
    clearMiddleConfigCache();

    const { status, body } = await request(app, '/v1/responses', {
      input: `My key is ${SECRET}`, stream: false,
    }, key);
    expect(status).toBe(200);
    const userOutboundResp = capturedMessages!.find((m: any) => m.role !== 'system');
    expect(userOutboundResp?.content).not.toContain(SECRET);
    expect((body as any).output_text).toContain(SECRET);
  });

  it('stream: secret redacted → provider sees placeholder → client sees real value', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('should not be called'); },
      async *streamChatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        const userMsg = messages.find((m: any) => m.role !== 'system');
        const placeholder = (userMsg?.content as string).match(/⟦R\d+:[0-9a-f]+⟧/)?.[0] ?? 'unknown';
        const mid = Math.floor(placeholder.length / 2);
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: `Key: ${placeholder.slice(0, mid)}` }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: `${placeholder.slice(mid)} end` }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      },
      validateKey: vi.fn(), platform: 'fake', name: 'Fake', baseUrl: 'http://fake',
    } as any));

    setSetting('middle_redaction_enabled', '1');
    clearMiddleConfigCache();

    const { status, text } = await request(app, '/v1/responses', {
      input: `My key is ${SECRET}`, stream: true,
    }, key);
    expect(status).toBe(200);
    const userOutboundRespStream = capturedMessages!.find((m: any) => m.role !== 'system');
    expect(userOutboundRespStream?.content).not.toContain(SECRET);
    // The SSE stream should contain the real value (un-redacted)
    expect(text).toContain(SECRET);
    // And NOT contain the placeholder
    expect(text).not.toMatch(/⟦R\d+:[0-9a-f]+⟧/);
  });
});
