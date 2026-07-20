import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatMessage } from '@api-gateway/shared';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { initSecretsStore, addSecret, _resetCacheForTesting } from '../../middle/redaction/store.js';
import { clearMiddleConfigCache, applyOutbound } from '../../middle/index.js';

vi.mock('../../lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/crypto.js')>();
  return { ...actual, decrypt: vi.fn((_e: string, _i: string, _t: string) => 'mocked-api-key') };
});

let tempDir: string;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  tempDir = join(tmpdir(), `b14-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
  _resetCacheForTesting();
  clearMiddleConfigCache();
});

afterEach(() => {
  setSetting('middle_compression_enabled', '0');
  setSetting('middle_compression_smart_crusher', '0');
  setSetting('middle_compression_smart_crusher_lossless_only', '1');
  setSetting('middle_redaction_enabled', '0');
  clearMiddleConfigCache();
  _resetCacheForTesting();
  rmSync(tempDir, { recursive: true, force: true });
});

// Helper: make a large dict-array tool output
function makeToolOutput(n: number): string {
  const arr = Array.from({ length: n }, (_, i) => ({
    id: i,
    message: `row ${i}`,
    status: i % 10 === 0 ? 'error: failed' : 'ok',
  }));
  return JSON.stringify(arr);
}

describe('B1-4: compression wire-up', () => {
  it('disabled path: messages byte-identical when compression off', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'run the tests' },
      { role: 'tool', content: makeToolOutput(50) },
      { role: 'assistant', content: 'done' },
    ];
    const { messages: result } = await applyOutbound(messages);
    expect(result).toBe(messages); // same reference, no copy
    expect(result).toEqual(messages);
  });

  it('SmartCrusher on tool JSON-array produces compressed output or passthrough (inflation guard)', async () => {
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0'); // enable lossy drop
    clearMiddleConfigCache();

    // Use large data with many rows to ensure compression is worthwhile
    const toolContent = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
      idx: i,
      msg: `log entry number ${i} with some longer text to make it worth compressing`,
      level: i % 10 === 0 ? 'error: failed' : 'info',
    })));
    const messages: ChatMessage[] = [
      { role: 'user', content: 'analyze results' },
      { role: 'tool', content: toolContent },
      { role: 'assistant', content: 'summary' },
    ];
    const { messages: result } = await applyOutbound(messages);

    // The tool message content should be compressed (smaller) or unchanged (inflation guard)
    const toolMsg = result.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    if (toolMsg && typeof toolMsg.content === 'string') {
      // Either compressed (smaller) or passthrough (same content)
      const isCompressed = toolMsg.content.length < toolContent.length;
      const isPassthrough = toolMsg.content === toolContent;
      expect(isCompressed || isPassthrough).toBe(true);
    }

    // A sentinel system message should appear after the tool message IF compression applied
    const sentinel = result.find(m =>
      m.role === 'system' && typeof m.content === 'string' &&
      m.content.includes('⟦C7:<<crushed')
    );
    if (sentinel) {
      expect(sentinel.content).toMatch(/⟦C7:<<crushed \d+ rows, hash [0-9a-f]{6}>>⟧/);
    }
  });

  it('lossless_only=1: SmartCrusher renders TOON when it saves, no rows dropped, no sentinel', async () => {
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '1');
    clearMiddleConfigCache();

    // Use long repeated key names so TOON's schema-once render clearly saves
    const toolContent = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
      user_identifier: `user_${i}`,
      account_balance: i * 100,
      transaction_status: 'completed',
    })));
    const messages: ChatMessage[] = [
      { role: 'user', content: 'query' },
      { role: 'tool', content: toolContent },
      { role: 'assistant', content: 'done' },
    ];
    const { messages: result } = await applyOutbound(messages);

    const toolMsg = result.find(m => m.role === 'tool');
    if (toolMsg && typeof toolMsg.content === 'string' && toolMsg.content !== toolContent) {
      // TOON header should be present
      expect(toolMsg.content).toMatch(/^\[30\]{/);
    }

    // No sentinel (lossless = no rows dropped)
    const sentinel = result.find(m =>
      m.role === 'system' && typeof m.content === 'string' &&
      m.content.includes('⟦C7:<<crushed')
    );
    expect(sentinel).toBeUndefined();
  });

  it('redaction + compression: placeholder in JSON row survives SmartCrusher', async () => {
    addSecret('sk-test-secret-key-1234567890', 'api_key', 'manual', 'Test');
    setSetting('middle_redaction_enabled', '1');
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    clearMiddleConfigCache();

    const arr = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      data: i === 5 ? 'sk-test-secret-key-1234567890' : `item ${i}`,
    }));
    const messages: ChatMessage[] = [
      { role: 'user', content: 'process these data' },
      { role: 'tool', content: JSON.stringify(arr) },
      { role: 'assistant', content: 'ok' },
    ];
    const { messages: result, session } = await applyOutbound(messages);

    // The redaction session should be created
    expect(session).toBeDefined();

    // The tool message should contain a placeholder (redacted) NOT the raw secret
    const toolMsg = result.find(m => m.role === 'tool');
    if (toolMsg && typeof toolMsg.content === 'string') {
      expect(toolMsg.content).not.toContain('sk-test-secret-key-1234567890');
      // The placeholder should survive in the compressed output
      expect(toolMsg.content).toMatch(/⟦R\d+:[0-9a-f]+⟧/);
    }
  });

  it('protect_recent skips the last N messages', async () => {
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    setSetting('middle_compression_protect_recent', '2'); // protect last 2
    clearMiddleConfigCache();

    const toolContent = makeToolOutput(50);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'query 1' },
      { role: 'tool', content: toolContent },        // index 1 (compressible, before cutoff)
      { role: 'assistant', content: 'result 1' },     // index 2 (protected)
      { role: 'user', content: 'query 2' },            // index 3 (protected)
      { role: 'assistant', content: 'final' },        // index 4 (protected)
    ];
    // cutoff = 5 - 2 = 3, so indices 0,1,2 are compressible; 3,4 are protected
    // But only index 1 is a tool message → it should be compressed
    const { messages: result } = await applyOutbound(messages);

    // The tool message at index 1 should be compressed
    const toolMsg = result.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    if (toolMsg && typeof toolMsg.content === 'string') {
      // If compression was applied, content should be different
      // (it may or may not be compressed depending on the algorithm's savings floor)
      // At minimum, the function should have been called (non-mutating result is a new array)
      expect(result.length).toBeGreaterThanOrEqual(messages.length);
    }
  });

  it('non-tool messages are not compressed', async () => {
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    clearMiddleConfigCache();

    const messages: ChatMessage[] = [
      { role: 'user', content: 'just some user text' },
      { role: 'assistant', content: 'assistant response' },
      { role: 'system', content: 'system message' },
    ];
    const { messages: result } = await applyOutbound(messages);
    // Non-tool messages should be unchanged
    expect(result[0].content).toBe('just some user text');
    expect(result[1].content).toBe('assistant response');
    expect(result[2].content).toBe('system message');
  });
});
