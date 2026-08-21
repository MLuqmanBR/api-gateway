import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { initSecretsStore, addSecret, _resetCacheForTesting } from '../../middle/redaction/store.js';
import { clearMiddleConfigCache } from '../../middle/index.js';
import { clearCompressionConfigCache } from '../../middle/compression/index.js';

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});
vi.mock('../../lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/crypto.js')>();
  return { ...actual, decrypt: vi.fn((_e: string, _i: string, _t: string) => 'mocked-api-key') };
});

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake', release: () => {} };
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
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, text, body: json };
}

const SECRET = 'sk-test-secret-key-1234567890';
let tempDir: string;
let app: Express;
let key: string;
let capturedMessages: any[] | null = null;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.PROXY_RATE_LIMIT_RPM = '0';
  initDb(':memory:');
  app = createApp();
  key = getUnifiedApiKey();
});

beforeEach(() => {
  tempDir = join(tmpdir(), `b16-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
  _resetCacheForTesting();
  clearMiddleConfigCache();
  clearCompressionConfigCache();
  capturedMessages = null;
  addSecret(SECRET, 'api_key', 'manual', 'Test');
  const db = getDb();
  db.prepare("DELETE FROM api_keys WHERE platform='fake'").run();
  db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('fake', 't', 'e', 'i', 'a', 'healthy', 1)").run();
  db.prepare("INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled) VALUES (9999, 'fake', 'fake-model', 'F', 5, 5, 'S', 1) ON CONFLICT(id) DO UPDATE SET platform='fake', model_id='fake-model', enabled=1").run();
});

afterEach(() => {
  setSetting('middle_compression_enabled', '0');
  setSetting('middle_compression_smart_crusher', '0');
  setSetting('middle_compression_smart_crusher_lossless_only', '1');
  setSetting('middle_redaction_enabled', '0');
  clearMiddleConfigCache();
  clearCompressionConfigCache();
  _resetCacheForTesting();
  rmSync(tempDir, { recursive: true, force: true });
});

// Helper: make a large dict-array tool output
// Older compressible tool output that sits BEFORE the protect_recent window (default 4):
// pad with trailing user messages so the tool message's index < messages.length - 4.
function withToolWindow(toolContent: string, padding = 5): Array<{ role: string; content: string }> {
  return [
    { role: 'user', content: 'analyze' },
    { role: 'tool', content: toolContent },
    ...Array.from({ length: padding }, (_, i) => ({ role: 'user', content: `context ${i}` })),
  ];
}

function makeToolOutput(n: number, opts: { longKeys?: boolean; errFree?: boolean } = {}): string {
  if (opts.longKeys) {
    return JSON.stringify(Array.from({ length: n }, (_, i) => ({
      user_identifier: `user_${i}`,
      account_balance: i * 100,
      transaction_status: i % 10 === 0 ? 'error: timeout' : 'completed',
    })));
  }
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({
    id: i,
    message: `log entry ${i} with some padding text for realism`,
    // errFree: drop the periodic error row so no must-keep constraint can
    // hijack the crush (the lossy drop path then deterministically applies).
    level: i % 10 === 0 && !opts.errFree ? 'error: failed' : 'info',
  })));
}

describe('B1-6: compression e2e', () => {
  // ── 1. Disabled ⇒ pass-through for compress step ────────────────────────
  it('disabled: provider receives original tool output unchanged', async () => {
    const toolContent = makeToolOutput(200);
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
      async *streamChatCompletion() { throw new Error('no'); },
      validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
    } as any));

    clearMiddleConfigCache();
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [
        { role: 'user', content: 'analyze' },
        { role: 'tool', content: toolContent },
      ],
      stream: false,
    }, key);
    expect(status).toBe(200);
    // Compression was OFF → provider received the original content
    const toolMsg = capturedMessages!.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe(toolContent);
  });

  // ── 2. Compression-only (redaction OFF) → provider receives compacted form ─
  it('compression-only: provider receives compressed tool output', async () => {
    // Error-free rows: no must-keep constraint can hijack the crush, so the
    // lossy drop path MUST apply (deterministic). Asserts the specific outcome —
    // the prior `isCompressed || isPassthrough` tautology could never fail.
    const toolContent = makeToolOutput(200, { errFree: true });
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
      async *streamChatCompletion() { throw new Error('no'); },
      validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
    } as any));

    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    setSetting('middle_compression_min_savings_ratio', '0.15');
    setSetting('middle_compression_emit_sentinel', '1');
    clearMiddleConfigCache();
    clearCompressionConfigCache();

    const { status } = await request(app, '/v1/chat/completions', {
      model: 'fake-model',
      // Pad past the protect_recent window (default 4) so the tool message is eligible.
      messages: withToolWindow(toolContent),
      stream: false,
    }, key);
    expect(status).toBe(200);
    const toolMsg = capturedMessages!.find((m: any) => m.role === 'tool');
    // Lossy path MUST compress (no error rows, no fences, no must-keep ids).
    expect(toolMsg.content).not.toBe(toolContent);                    // actually transformed
    expect(String(toolMsg.content).length).toBeLessThan(toolContent.length); // smaller
    // The sentinel is appended to the compressed tool message content itself
    // (M46 — never a separate system message after tool messages).
    const upstreamText = JSON.stringify(capturedMessages);
    expect(upstreamText).toMatch(/⟦C7:<<crushed \d+ rows, hash [0-9a-f]{6}>>⟧/); // sentinel present upstream
  });

  // ── 3. Both-enabled ordering (§0 invariant #2) ──────────────────────────
  it('both-enabled: placeholder + compression — provider sees placeholder not raw secret', async () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      data: i === 5 ? SECRET : `item ${i}`,
      level: i % 10 === 0 ? 'error: failed' : 'info',
    }));
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
      async *streamChatCompletion() { throw new Error('no'); },
      validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
    } as any));

    setSetting('middle_redaction_enabled', '1');
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    clearMiddleConfigCache();

    const { status } = await request(app, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [
        { role: 'user', content: 'process' },
        { role: 'tool', content: JSON.stringify(arr) },
      ],
      stream: false,
    }, key);
    expect(status).toBe(200);
    // Provider received placeholder, NOT the raw secret
    const allContent = JSON.stringify(capturedMessages);
    expect(allContent).not.toContain(SECRET);
    // Placeholder IS present in the upstream body
    expect(allContent).toMatch(/⟦R\d+:[0-9a-f]+⟧/);
  });

  // ── 4. Sentinel round-trip: sentinel in upstream body, not in response ──
  it('sentinel: appears in upstream body, NOT in client response', async () => {
    // Error-free rows so the lossy drop path deterministically emits a sentinel
    // (the longKeys variant's `error: timeout` rows keep the whole array alive
    // via the must-keep constraint → passthrough, nothing upstream to assert).
    const toolContent = makeToolOutput(200, { errFree: true });
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: 'response without sentinel' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
      async *streamChatCompletion() { throw new Error('no'); },
      validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
    } as any));

    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    setSetting('middle_compression_min_savings_ratio', '0.15');
    setSetting('middle_compression_emit_sentinel', '1');
    clearMiddleConfigCache();
    clearCompressionConfigCache();

    const { status, body } = await request(app, '/v1/chat/completions', {
      model: 'fake-model',
      messages: withToolWindow(toolContent),
      stream: false,
    }, key);
    expect(status).toBe(200);
    // Client response should NOT contain the sentinel
    const responseContent = (body as any).choices[0].message.content;
    expect(responseContent).not.toMatch(/⟦C7:<<crushed/);
    // The sentinel MUST reach the upstream provider — with an error-free 200-row
    // tool output the lossy path always applies, so a missing sentinel means the
    // compressor silently did nothing.
    const upstreamContent = JSON.stringify(capturedMessages);
    expect(upstreamContent).toMatch(/⟦C7:<<crushed/);
  });

  // ── 5. Inflation guard: passthrough when compressed ≥ original ──────────
  it('inflation guard: small array → passthrough, no sentinel', async () => {
    const smallArray = JSON.stringify([{ id: 1, msg: 'short' }]);
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
      async *streamChatCompletion() { throw new Error('no'); },
      validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
    } as any));

    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    clearMiddleConfigCache();

    const { status } = await request(app, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [
        { role: 'user', content: 'query' },
        { role: 'tool', content: smallArray },
      ],
      stream: false,
    }, key);
    expect(status).toBe(200);
    // Small array should not be compressed (inflation guard or min-savings floor)
    const toolMsg = capturedMessages!.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe(smallArray);
  });

  // ── 6. Off-limits: fenced code inside tool output survives ──────────────
  it('off-limits: fenced code block inside JSON tool output survives', async () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      code: i === 0 ? '```python\nprint("protected")\n```' : `line ${i}`,
    }));
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion(_k: string, messages: any[]) {
        capturedMessages = messages;
        return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
      },
      async *streamChatCompletion() { throw new Error('no'); },
      validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
    } as any));

    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    setSetting('middle_compression_smart_crusher_lossless_only', '0');
    clearMiddleConfigCache();

    const { status } = await request(app, '/v1/chat/completions', {
      model: 'fake-model',
      messages: [
        { role: 'user', content: 'query' },
        { role: 'tool', content: JSON.stringify(arr) },
      ],
      stream: false,
    }, key);
    expect(status).toBe(200);
    // If compression applied, the fenced code must survive in the upstream body
    const upstreamContent = JSON.stringify(capturedMessages);
    expect(upstreamContent).toContain('protected');
  });
});

// ── 7. Fuzz: seeded-PRNG ≥200 cases ─────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('B1-6: fuzz ≥200 cases', () => {
  it('random JSON-array tool outputs → error rows kept, placeholder survives, order preserved', async () => {
    const rng = mulberry32(99);
    const N = 200;
    let failures = 0;
    const sampleErrors: string[] = [];

    for (let i = 0; i < N; i++) {
      const rowCount = 5 + Math.floor(rng() * 196); // 5-200
      const errorRows = new Set<number>();
      const hasPlaceholder = rng() > 0.5;
      const placeholderIdx = Math.floor(rng() * rowCount);

      const arr = Array.from({ length: rowCount }, (_, j) => {
        const isError = rng() > 0.85;
        if (isError) errorRows.add(j);
        return {
          id: j,
          data: hasPlaceholder && j === placeholderIdx ? SECRET : `row ${j} data`,
          level: isError ? 'error: failed' : 'info',
        };
      });

      mockRouteRequest.mockReturnValue(fakeRoute({
        async chatCompletion(_k: string, messages: any[]) {
          capturedMessages = messages;
          return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
        async *streamChatCompletion() { throw new Error('no'); },
        validateKey: vi.fn(), platform: 'fake', name: 'F', baseUrl: 'http://f',
      } as any));

      setSetting('middle_redaction_enabled', hasPlaceholder ? '1' : '0');
      setSetting('middle_compression_enabled', '1');
      setSetting('middle_compression_smart_crusher', '1');
      setSetting('middle_compression_smart_crusher_lossless_only', '0');
      clearMiddleConfigCache();

      const { status } = await request(app, '/v1/chat/completions', {
        model: 'fake-model',
        messages: [
          { role: 'user', content: 'query' },
          { role: 'tool', content: JSON.stringify(arr) },
        ],
        stream: false,
      }, key);

      if (status !== 200) { failures++; if (sampleErrors.length < 3) sampleErrors.push(`case ${i}: status ${status}`); continue; }

      const upstreamContent = JSON.stringify(capturedMessages);
      // Placeholder must survive (never the raw secret)
      if (hasPlaceholder) {
        if (upstreamContent.includes(SECRET)) { failures++; if (sampleErrors.length < 3) sampleErrors.push(`case ${i}: raw secret leaked`); continue; }
        if (!upstreamContent.match(/⟦R\d+:[0-9a-f]+⟧/)) { failures++; if (sampleErrors.length < 3) sampleErrors.push(`case ${i}: placeholder missing`); continue; }
      }

      // Error rows must survive in the upstream content — the must-keep
      // constraint should prevent compression from dropping any. Rows are
      // TOON-rendered as CSV (`<id>,<message>,...,<level>`), so an error row's
      // `id` appears as a bare CSV number, e.g. `,7,` — assert on that form.
      // The prior body was comments only and never actually checked.
      for (const errIdx of errorRows) {
        const re = new RegExp(`(?:^|[^0-9])${errIdx}(?:[^0-9]|$)`);
        if (!re.test(upstreamContent)) {
          failures++;
          if (sampleErrors.length < 3) sampleErrors.push(`case ${i}: error row id=${errIdx} dropped`);
          break;
        }
      }
    }

    if (failures > 0) console.error('Fuzz failures:', failures, sampleErrors);
    expect(failures).toBe(0);
  });
});
