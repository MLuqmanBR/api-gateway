import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// `` tag extraction integration (proxy.ts hold-window): the proxy
// must split inline `` reasoning from the visible answer for
// models that match the reasoning-pattern gate. Non-reasoning
// models pass through unchanged.
//
// The mock upstream intercepts provider URLs (cerebras, mistral,
// groq, etc.). We pin each test to a model id that exists in the
// seeded catalog and add a key for the platform so the route has a
// real (mocked) target. Reasoning tests use mistral/magistral-*
// (matches the 'magistral' gate); the negative test uses
// groq/llama-3.3-70b-versatile (does not match the gate).

async function request(app: Express, path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getUnifiedApiKey()}`,
      ...extraHeaders,
    },
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

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

const roleChunk = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] };
const textChunk = (s: string) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: s }, finish_reason: null }] });
const finishChunk = (reason: string) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: reason }] });

function mockUpstream(script: Array<{ body: string; status?: number }>) {
  const origFetch = global.fetch;
  let call = 0;
  const seen: Array<{ model: string }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (!/api\.groq\.com|openrouter\.ai|api\.cohere|generativelanguage|integrate\.api\.nvidia|api\.cerebras|api\.mistral|router\.huggingface|api\.cloudflare|models\.github|open\.bigmodel|api\.llm7|api\.kilo|text\.pollinations|ollama\.com|opencode\.ai/.test(urlStr)) {
      return origFetch(url as Request, init);
    }
    const reqBody = JSON.parse(String((init as RequestInit).body));
    seen.push({ model: reqBody.model });
    const step = script[Math.min(call++, script.length - 1)];
    return new Response(step.body, {
      status: step.status ?? 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  return { seen, calls: () => call };
}

async function addKey(app: Express, dashToken: string, platform: string, key: string) {
  const r = await request(app, '/api/keys',
    { platform, key, label: 't' },
    { Authorization: `Bearer ${dashToken}` });
  return r.status;
}

describe('proxy stream think-tag extraction', () => {
  let app: Express;
  let dashToken = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    expect(await addKey(app, dashToken, 'groq', 'gsk_think_tags')).toBe(201);
    expect(await addKey(app, dashToken, 'mistral', 'ms_think_tags')).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts a single complete think block from a reasoning-model stream', async () => {
    // mistral/magistral-medium-latest is in the seeded catalog and
    // matches the 'magistral' gate.
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('<think>The user wants a simple answer.</think>42.'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'What is 6*7?' }],
    });
    if (r.status !== 200) {
      throw new Error(`unexpected status ${r.status}: body=${JSON.stringify(r.body)} text=${r.text.slice(0, 500)}`);
    }
    const fs = frames(r.text);
    // No frame should carry the literal `` tag text in content.
    const textContent = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(textContent).not.toContain('<think>');
    expect(textContent).not.toContain('</think>');
    // The visible answer must reach the client.
    expect(textContent).toContain('42.');
    // The reasoning must arrive as a `reasoning_content` delta.
    const reasoningDeltas = fs.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').filter(s => s.length > 0);
    expect(reasoningDeltas.join('')).toContain('The user wants a simple answer.');
  });

  it('passes literal `` tags through unchanged for a non-reasoning model', async () => {
    // groq/llama-3.3-70b-versatile does not match the gate. The gate
    // is on model id, not on content presence. A non-reasoning model
    // that produces a literal tag in its answer (synthetic) is left
    // alone.
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('hello world <think>not extracted</think> done'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'tag passthrough test' }],
    });
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    const textContent = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    // The literal tags survive.
    expect(textContent).toContain('<think>');
    expect(textContent).toContain('</think>');
    // No reasoning_content delta is emitted.
    const reasoningDeltas = fs.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').filter(s => s.length > 0);
    expect(reasoningDeltas).toHaveLength(0);
  });

  it('extracts a think block split across multiple chunks', async () => {
    // Live-captured shape: open in chunk 1, body in chunk 2-3,
    // close + visible in chunk 4. The state machine must hold the
    // unclosed opener across feeds.
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('<think>The user is asking '),
        textChunk('a simple multiplication '),
        textChunk('question.</think>6 * 7 = 42.'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'chunked test' }],
    });
    if (r.status !== 200) {
      throw new Error(`unexpected status ${r.status}: body=${JSON.stringify(r.body)}`);
    }
    const fs = frames(r.text);
    const textContent = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(textContent).not.toContain('<think>');
    expect(textContent).not.toContain('</think>');
    expect(textContent).toContain('6 * 7 = 42.');
    const reasoningJoined = fs.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(reasoningJoined).toContain('simple multiplication');
  });

  it('treats an unclosed think tag at end-of-stream as visible text', async () => {
    // The stream ends with a dangling `<...>r` — the model never
    // closed the block. The "residual as visible" policy means
    // the literal tag text + the trailing word reach the client
    // (losing one block of reasoning is much less bad than
    // dropping the actual answer).
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('<think>rambled reasoning without close'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'unclosed test' }],
    });
    if (r.status !== 200) {
      throw new Error(`unexpected status ${r.status}: body=${JSON.stringify(r.body)}`);
    }
    const fs = frames(r.text);
    const textContent = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    // The unclosed opener and trailing word are visible.
    expect(textContent).toContain('<think>rambled reasoning without close');
    // No reasoning_content delta was emitted.
    const reasoningDeltas = fs.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').filter(s => s.length > 0);
    expect(reasoningDeltas).toHaveLength(0);
  });

  it('extracts every complete block in a multi-block response', async () => {
    // Multiple sequential think blocks. Reasoning is concatenated
    // in order; visible text shows only the inter-block content.
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('<think>first</think>X<think>second</think>Y'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'multi-block test' }],
    });
    if (r.status !== 200) {
      throw new Error(`unexpected status ${r.status}: body=${JSON.stringify(r.body)}`);
    }
    const fs = frames(r.text);
    const textContent = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(textContent).toBe('XY');
    const reasoningJoined = fs.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(reasoningJoined).toBe('firstsecond');
  });

  it('preserves a code block containing the word "think" in a comment', async () => {
    // Word "think" in a comment is NOT a tag. The extractor only
    // matches the literal 7-char tag, so the code block passes
    // through untouched.
    mockUpstream([{
      body: sse(
        roleChunk,
        textChunk('<think>meta</think>```python\n# think: simple\n```'),
        finishChunk('stop'),
        '[DONE]',
      ),
    }]);
    const r = await request(app, '/v1/chat/completions', {
      stream: true,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'word think test' }],
    });
    if (r.status !== 200) {
      throw new Error(`unexpected status ${r.status}: body=${JSON.stringify(r.body)}`);
    }
    const fs = frames(r.text);
    const textContent = fs.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(textContent).toContain('```python');
    expect(textContent).toContain('# think: simple');
    const reasoningJoined = fs.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(reasoningJoined).toBe('meta');
  });
});
