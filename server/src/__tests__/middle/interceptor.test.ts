import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatMessage } from '@api-gateway/shared/types.js';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { initSecretsStore, addSecret, getActiveSecretsForRedaction, _resetCacheForTesting } from '../../middle/redaction/store.js';
import { RedactionSession } from '../../middle/redaction/session.js';
import { interceptOutbound, interceptInbound, getInterceptorFailures, _resetInterceptorStateForTesting } from '../../middle/redaction/interceptor.js';
import { buildProviderFor } from '../../providers/index.js';

// Mock crypto.decrypt so placeholder keys don't fail AES-GCM validation.
vi.mock('../../lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/crypto.js')>();
  return {
    ...actual,
    decrypt: vi.fn((_enc: string, _iv: string, _tag: string) => 'mocked-api-key'),
  };
});

// Mock the provider module so chatCompletion returns controlled responses.
vi.mock('../../providers/index.js', () => ({
  buildProviderFor: vi.fn(),
}));

let tempDir: string;
let mockChatCompletion: Mock;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  tempDir = join(tmpdir(), `middle-interceptor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
  _resetInterceptorStateForTesting();

  // Set up a model + key for the interceptor
  const db = getDb();
  db.prepare("INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled) VALUES (999, 'groq', 'interceptor-model', 'Interceptor', 5, 5, 'Small', 1) ON CONFLICT(id) DO UPDATE SET platform='groq', model_id='interceptor-model', enabled=1").run();
  db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'test', 'enc', 'iv', 'tag', 'healthy', 1)").run();
  setSetting('middle_interceptor_model', '999');
  setSetting('middle_interceptor_timeout_ms', '4000');
  setSetting('middle_detection_targets', '["api_key","email","phone","person","address"]');

  // Set up the mock provider
  mockChatCompletion = vi.fn();
  vi.mocked(buildProviderFor).mockReturnValue({
    chatCompletion: mockChatCompletion,
    streamChatCompletion: vi.fn(),
    validateKey: vi.fn(),
    platform: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com',
    keyless: false,
  } as unknown as ReturnType<typeof buildProviderFor>);

  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetCacheForTesting();
  vi.restoreAllMocks();
});

function mockResponse(content: string): unknown {
  return {
    choices: [{ message: { role: 'assistant', content } }],
  };
}

describe('interceptOutbound — valid spans', () => {
  it('adds found secrets to the store and re-redacts messages', async () => {
    mockChatCompletion.mockResolvedValue(mockResponse(JSON.stringify([
      { exact: 'gsk_new-secret-key', kind: 'api_key' },
    ])));

    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'use gsk_new-secret-key for the request' },
    ];

    const redacted = session.redactOutbound(messages);
    expect(redacted[0].content).toContain('gsk_new-secret-key');

    const result = await interceptOutbound(redacted, session);
    expect(result.newSecretsFound).toBe(true);
    expect(result.messages[0].content).not.toContain('gsk_new-secret-key');
    expect(result.messages[0].content).toContain('⟦R');

    const active = getActiveSecretsForRedaction();
    expect(active.some(s => s.value === 'gsk_new-secret-key')).toBe(true);
  });
});

describe('interceptOutbound — whole-message secret accepted', () => {
  // Regression: a previous plausibility gate rejected spans whose length
  // exceeded 40% of the text. A message that IS the secret (a bare PAT or
  // API key, possibly pasted alone) must still be redacted.
  it('redacts a secret that spans the entire message', async () => {
    const wholeSecret = 'ghp_wholemessage0123456789abcdef';
    mockChatCompletion.mockResolvedValue(mockResponse(JSON.stringify([
      { exact: wholeSecret, kind: 'api_key' },
    ])));

    const session = new RedactionSession();
    const messages: ChatMessage[] = [{ role: 'user', content: wholeSecret }];

    const result = await interceptOutbound(session.redactOutbound(messages), session);
    expect(result.newSecretsFound).toBe(true);
    expect(result.messages[0].content).not.toContain(wholeSecret);
    expect(result.messages[0].content).toContain('⟦R');
  });
});

describe('interceptOutbound — absent substring discarded', () => {
  it('discards spans not found verbatim in the text', async () => {
    mockChatCompletion.mockResolvedValue(mockResponse(JSON.stringify([
      { exact: 'this-substring-does-not-exist', kind: 'api_key' },
    ])));

    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'no secrets here' },
    ];
    const redacted = session.redactOutbound(messages);
    const result = await interceptOutbound(redacted, session);
    expect(result.newSecretsFound).toBe(false);
    expect(result.messages[0].content).toBe('no secrets here');
    expect(getActiveSecretsForRedaction()).toHaveLength(0);
  });
});

describe('interceptOutbound — timeout → Stage-1 only', () => {
  it('continues with Stage-1 output on timeout, request still dispatched', async () => {
    mockChatCompletion.mockRejectedValue(new Error('Timeout'));

    addSecret('known-secret', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'use known-secret here' },
    ];
    const redacted = session.redactOutbound(messages);
    expect(redacted[0].content).not.toContain('known-secret');

    const result = await interceptOutbound(redacted, session);
    expect(result.newSecretsFound).toBe(false);
    expect(result.messages[0].content).not.toContain('known-secret');
    expect(getInterceptorFailures()).toBeGreaterThan(0);
  });
});

describe('interceptOutbound — malformed JSON → Stage-1 only', () => {
  it('handles non-JSON interceptor responses gracefully', async () => {
    mockChatCompletion.mockResolvedValue(mockResponse('not valid json'));

    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello world' },
    ];
    const redacted = session.redactOutbound(messages);
    const result = await interceptOutbound(redacted, session);
    expect(result.newSecretsFound).toBe(false);
    expect(result.messages[0].content).toBe('hello world');
    expect(getInterceptorFailures()).toBeGreaterThan(0);
  });
});

describe('interceptOutbound — scanned-cache prevents re-scanning', () => {
  it('skips messages already scanned in a previous call', async () => {
    mockChatCompletion.mockResolvedValue(mockResponse('[]'));

    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'same text every time' },
    ];
    await interceptOutbound(messages, session);
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);

    await interceptOutbound(messages, session);
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('interceptOutbound — no model configured', () => {
  it('returns messages unchanged when no interceptor model is set', async () => {
    setSetting('middle_interceptor_model', '');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'test' },
    ];
    const result = await interceptOutbound(messages, session);
    expect(result.newSecretsFound).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

describe('interceptInbound — valid spans', () => {
  it('redacts model-emitted new secrets in the response text', async () => {
    setSetting('middle_interceptor_inbound_enabled', '1');
    mockChatCompletion.mockResolvedValue(mockResponse(JSON.stringify([
      { exact: 'AKIA-emitted-by-model', kind: 'api_key' },
    ])));

    const session = new RedactionSession();
    const text = 'The result is AKIA-emitted-by-model and that is all';
    const result = await interceptInbound(text, session);
    expect(result.newSecretsFound).toBe(true);
    expect(result.text).not.toContain('AKIA-emitted-by-model');
    expect(result.text).toContain('⟦R');

    const active = getActiveSecretsForRedaction();
    expect(active.some(s => s.value === 'AKIA-emitted-by-model')).toBe(true);
  });
});

describe('interceptInbound — disabled by default', () => {
  it('returns text unchanged when inbound interceptor is off', async () => {
    const session = new RedactionSession();
    const text = 'some response text';
    const result = await interceptInbound(text, session);
    expect(result.newSecretsFound).toBe(false);
    expect(result.text).toBe(text);
  });
});

describe('interceptInbound — timeout → text unchanged', () => {
  it('returns original text on interceptor timeout', async () => {
    setSetting('middle_interceptor_inbound_enabled', '1');
    mockChatCompletion.mockRejectedValue(new Error('Timeout'));

    const session = new RedactionSession();
    const text = 'response with potential secret';
    const result = await interceptInbound(text, session);
    expect(result.newSecretsFound).toBe(false);
    expect(result.text).toBe(text);
    expect(getInterceptorFailures()).toBeGreaterThan(0);
  });
});
