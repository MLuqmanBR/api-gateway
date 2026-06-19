import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// `` tag extraction integration (proxy.ts non-streaming path): the
// proxy must split inline `` reasoning from the visible answer
// for models that match the reasoning-pattern gate. Non-reasoning
// models pass through unchanged.

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
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function mockUpstreamJson(payload: object, platform: 'groq' | 'mistral' | 'cerebras' = 'mistral') {
  const origFetch = global.fetch;
  const seen: Array<{ model: string }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (!/api\.groq\.com|openrouter\.ai|api\.cohere|generativelanguage|integrate\.api\.nvidia|api\.cerebras|api\.mistral|router\.huggingface|api\.cloudflare|models\.github|open\.bigmodel|api\.llm7|api\.kilo|text\.pollinations|ollama\.com|opencode\.ai/.test(urlStr)) {
      return origFetch(url as Request, init);
    }
    const reqBody = JSON.parse(String((init as RequestInit).body));
    seen.push({ model: reqBody.model });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return seen;
}

async function addKey(app: Express, dashToken: string, platform: string, key: string) {
  const r = await request(app, '/api/keys',
    { platform, key, label: 't' },
    { Authorization: `Bearer ${dashToken}` });
  return r.status;
}

describe('proxy non-stream think-tag extraction', () => {
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
    expect(await addKey(app, dashToken, 'groq', 'gsk_think_tags_ns')).toBe(201);
    expect(await addKey(app, dashToken, 'mistral', 'ms_think_tags_ns')).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts a complete think block from a reasoning-model non-stream response', async () => {
    mockUpstreamJson({
      id: 'r1', object: 'chat.completion', created: 1, model: 'magistral-medium-latest',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '<think>The user wants the answer.</think>42.' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });
    const r = await request(app, '/v1/chat/completions', {
      stream: false,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'What is 6*7?' }],
    });
    if (r.status !== 200) {
      throw new Error(`unexpected status ${r.status}: body=${JSON.stringify(r.body)}`);
    }
    const msg = r.body.choices[0].message;
    expect(msg.content).toBe('42.');
    expect(msg.reasoning_content).toBe('The user wants the answer.');
  });

  it('passes literal `` tags through unchanged for a non-reasoning model', async () => {
    mockUpstreamJson({
      id: 'r1', object: 'chat.completion', created: 1, model: 'llama-3.3-70b-versatile',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello world <think>not extracted</think> done' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });
    const r = await request(app, '/v1/chat/completions', {
      stream: false,
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'tag passthrough test' }],
    });
    expect(r.status).toBe(200);
    const msg = r.body.choices[0].message;
    expect(msg.content).toContain('<think>');
    expect(msg.content).toContain('</think>');
    // The reasoning field is not added for non-reasoning models.
    expect(msg.reasoning_content ?? null).toBeNull();
  });

  it('extracts every complete block in a multi-block response', async () => {
    // Two complete blocks. Reasoning is concatenated; visible
    // contains the inter-block text. Documented text-only
    // limitation: a literal tag pair inside the visible text is
    // also extracted. This test avoids that by using single-char
    // inter-block text.
    mockUpstreamJson({
      id: 'r1', object: 'chat.completion', created: 1, model: 'magistral-medium-latest',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '<think>first</think>X<think>second</think>Y' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });
    const r = await request(app, '/v1/chat/completions', {
      stream: false,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'multi-block test' }],
    });
    expect(r.status).toBe(200);
    const msg = r.body.choices[0].message;
    expect(msg.content).toBe('XY');
    expect(msg.reasoning_content).toBe('firstsecond');
  });

  it('preserves a code block containing the word "think" in a comment', async () => {
    // The literal `` tag in a string literal inside a Python
    // code block is a complete block and will be extracted too —
    // this is a documented text-only limit. The test below uses
    // a code block where the word "think" is a comment, not a
    // tag pair, so the extraction applies only to the real think
    // block at the start.
    mockUpstreamJson({
      id: 'r1', object: 'chat.completion', created: 1, model: 'magistral-medium-latest',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '<think>meta</think>```python\n# think: simple\n```' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });
    const r = await request(app, '/v1/chat/completions', {
      stream: false,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'word think test' }],
    });
    expect(r.status).toBe(200);
    const msg = r.body.choices[0].message;
    expect(msg.content).toContain('```python');
    expect(msg.content).toContain('# think: simple');
    expect(msg.reasoning_content).toBe('meta');
  });

  it('preserves tool_calls alongside a think block', async () => {
    // A response with both tool_calls and a think block. Both are
    // preserved; think is moved to reasoning_content; tool_calls
    // is unchanged. Mirrors the streaming tool-call behavior in
    // proxy-stream-integrity.test.ts.
    mockUpstreamJson({
      id: 'r1', object: 'chat.completion', created: 1, model: 'magistral-medium-latest',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '<think>Calling Read to look up the file.</think>',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path": "/tmp/a"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });
    const r = await request(app, '/v1/chat/completions', {
      stream: false,
      model: 'mistral/magistral-medium-latest',
      messages: [{ role: 'user', content: 'tool+think test' }],
    });
    expect(r.status).toBe(200);
    const msg = r.body.choices[0].message;
    // content is the visible text after the think block — empty.
    expect(msg.content === null || msg.content === '').toBe(true);
    // reasoning is the meta-reasoning.
    expect(msg.reasoning_content).toBe('Calling Read to look up the file.');
    // tool_calls is preserved.
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].function.name).toBe('Read');
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ file_path: '/tmp/a' });
  });
});
