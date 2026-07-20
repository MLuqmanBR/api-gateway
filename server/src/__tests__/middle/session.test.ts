import type { ChatMessage, ChatContentBlock } from '@api-gateway/shared/types.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb } from '../../db/index.js';
import { initSecretsStore, addSecret, _resetCacheForTesting } from '../../middle/redaction/store.js';
import { RedactionSession } from '../../middle/redaction/session.js';

let tempDir: string;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  tempDir = join(tmpdir(), `middle-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetCacheForTesting();
});

describe('RedactionSession — redactOutbound', () => {
  it('redacts a secret in string content', () => {
    addSecret('sk-my-api-key-123', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'my key is sk-my-api-key-123 please help' },
    ];
    const out = session.redactOutbound(messages);
    expect(out[0].content).not.toContain('sk-my-api-key-123');
    expect(out[0].content).toContain('⟦R');
  });

  it('redacts secrets in tool_calls arguments', () => {
    addSecret('secret-token', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'do_thing', arguments: '{"token":"secret-token"}' },
        }],
      },
    ];
    const out = session.redactOutbound(messages);
    const args = (out[0].tool_calls![0].function.arguments);
    expect(args).not.toContain('secret-token');
    // tool_call arguments must still be valid JSON after redaction
    expect(() => JSON.parse(args)).not.toThrow();
  });

  it('redacts secrets in reasoning_content', () => {
    addSecret('secret-key', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'thinking about secret-key here',
        reasoning_content: 'I need to use secret-key for the request',
      },
    ];
    const out = session.redactOutbound(messages);
    expect(out[0].reasoning_content).not.toContain('secret-key');
    expect(out[0].reasoning_content).toContain('⟦R');
  });

  it('redacts secrets in parts-array text blocks (leaves image_url untouched)', () => {
    addSecret('img-secret', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at img-secret here' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,img-secret' } },
        ],
      },
    ];
    const out = session.redactOutbound(messages);
    const content = out[0].content as ChatContentBlock[];
    // Text block redacted
    const textBlock = content[0];
    if (typeof textBlock === 'object' && textBlock !== null) {
      expect(textBlock.text).not.toContain('img-secret');
      expect(textBlock.text).toContain('⟦R');
    }
    // Image URL block NOT redacted — stringify to avoid type-narrowing noise,
    // just verify the plaintext survived (the block is off-limits).
    expect(JSON.stringify(content[1])).toContain('img-secret');
  });

  it('redacts tool-message content (the bash-output/file-content path)', () => {
    addSecret('AKIAIOSFODNN7EXAMPLE', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        content: 'Command output: export AWS_KEY=AKIAIOSFODNN7EXAMPLE',
        tool_call_id: 'call_1',
      },
    ];
    const out = session.redactOutbound(messages);
    expect(out[0].content).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('does not mutate the original message array', () => {
    addSecret('original-secret', 'api_key', 'manual');
    const session = new RedactionSession();
    const original: ChatMessage[] = [
      { role: 'user', content: 'here is original-secret' },
    ];
    const originalContent = original[0].content;
    session.redactOutbound(original);
    // Original untouched
    expect(original[0].content).toBe(originalContent);
    expect(original[0].content).toContain('original-secret');
  });

  it('handles empty secrets gracefully (pass-through)', () => {
    const session = new RedactionSession([]);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'no secrets to redact' },
    ];
    const out = session.redactOutbound(messages);
    expect(out[0].content).toBe('no secrets to redact');
    expect(session.hasRedactions()).toBe(false);
  });
});

describe('RedactionSession — unredactText', () => {
  it('restores original values from placeholders', () => {
    addSecret('my-secret-value', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'use my-secret-value now' },
    ];
    const redacted = session.redactOutbound(messages);
    const restored = session.unredactText(redacted[0].content as string);
    expect(restored).toBe('use my-secret-value now');
  });

  it('restores values in tool_call arguments round-trip', () => {
    addSecret('token-value', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'do_thing', arguments: '{"token":"token-value"}' },
        }],
      },
    ];
    const redacted = session.redactOutbound(messages);
    const redactedArgs = redacted[0].tool_calls![0].function.arguments;
    const restoredArgs = session.unredactText(redactedArgs);
    expect(restoredArgs).toBe('{"token":"token-value"}');
  });
});

describe('RedactionSession — multiple secrets', () => {
  it('redacts multiple different secrets in the same message', () => {
    addSecret('KEY1', 'api_key', 'manual');
    addSecret('KEY2', 'api_key', 'manual');
    const session = new RedactionSession();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'use KEY1 and KEY2 together' },
    ];
    const out = session.redactOutbound(messages);
    expect(out[0].content).not.toContain('KEY1');
    expect(out[0].content).not.toContain('KEY2');
    const restored = session.unredactText(out[0].content as string);
    expect(restored).toBe('use KEY1 and KEY2 together');
  });
});
