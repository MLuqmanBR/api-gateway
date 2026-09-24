import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'http';

// F6: Anthropic /v1/messages integration test — verifies the endpoint accepts
// Anthropic-format requests and returns Anthropic-format responses by
// translating to OpenAI-compat internally and back.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as unknown as Record<string, unknown>;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy, setGlobalRetryLimit } from '../../services/router.js';
import { setMessagesHttpServer } from '../../routes/messages.js';

async function postMessages(app: Express, key: string, body: any) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Anthropic /v1/messages inbound (F6)', () => {
  let app: Express;
  let key: string;
  // The messages route forwards to /v1/chat/completions via a loopback
  // sub-request to setMessagesHttpServer's registered server. Registering an
  // ephemeral server scoped to this suite makes the sub-request hit THIS app,
  // not whatever happens to be listening on PORT/3001 (a stale dev gateway,
  // etc.). The helper's per-call listen() still validates the outer endpoint.
  let selfServer: Server;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    selfServer = app.listen(0);
    setMessagesHttpServer(selfServer);
    key = getUnifiedApiKey();

    setRoutingStrategy('priority');
    setGlobalRetryLimit(0);
    const db = getDb();
    const k1 = encrypt('the-only-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'only', ?, ?, ?, 'healthy', 1)
    `).run(k1.encrypted, k1.iv, k1.authTag);
    db.prepare(`
      UPDATE fallback_config SET enabled = 0
      WHERE model_db_id NOT IN (
        SELECT id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();
    db.prepare(`
      UPDATE api_keys SET enabled = 0 WHERE id NOT IN (
        SELECT id FROM api_keys WHERE platform = 'groq' ORDER BY id LIMIT 1
      )
    `).run();

    chatCompletion.mockImplementation(async () => ({
      id: 'chatcmpl-123',
      object: 'chat.completion',
      model: 'groq/test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello from the gateway!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }));
  });

  afterAll(() => {
    selfServer.close();
    setMessagesHttpServer(null as unknown as Server);
  });

  afterEach(() => {
    // The streaming test installs a generator on streamChatCompletion; reset
    // it so it can't leak into any later case in this file.
    streamChatCompletion.mockReset();
  });

  it('accepts x-api-key auth (Anthropic convention)', async () => {
    const res = await postMessages(app, key, {
      model: 'auto',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.role).toBe('assistant');
    expect(res.body.content).toHaveLength(1);
    expect(res.body.content[0]).toEqual({ type: 'text', text: 'Hello from the gateway!' });
    expect(res.body.stop_reason).toBe('end_turn');
  });

  it('rejects with 401 when no API key', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] }),
    });
    server.close();
    expect(res.status).toBe(401);
  });

  it('rejects with 400 on malformed request', async () => {
    const res = await postMessages(app, key, {
      model: 'auto',
      // missing messages
      max_tokens: 100,
    });
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('error');
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('translates system message and returns Anthropic response', async () => {
    const res = await postMessages(app, key, {
      model: 'auto',
      max_tokens: 100,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.content[0]).toEqual({ type: 'text', text: 'Hello from the gateway!' });
  });

  it('translates tool_use and tool_result round-trip', async () => {
    // First test tool_result inbound translation
    chatCompletion.mockImplementationOnce(async () => ({
      id: 'chatcmpl-456',
      object: 'chat.completion',
      model: 'groq/test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    const res = await postMessages(app, key, {
      model: 'auto',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 72F' }],
      }],
    });
    expect(res.status).toBe(200);
    expect(res.body.stop_reason).toBe('tool_use');
    const toolUseBlock = res.body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUseBlock).toEqual({
      type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' },
    });
  });

  it('emits a thinking content block before the text block when upstream streams reasoning_content', async () => {
    // The /v1/messages SSE translator must forward the canonical
    // reasoning_content channel as Anthropic thinking_delta blocks — without
    // this, Anthropic-format clients (Claude Code) lose the whole thinking
    // stream. The non-streaming path already maps reasoning_content → a
    // `thinking` block (anthropic-translate.ts), so this pins the streaming
    // side to the same shape.
    streamChatCompletion.mockImplementation(async function* () {
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      yield chunk({ reasoning_content: 'step one' });
      yield chunk({ reasoning_content: 'step two' });
      yield chunk({ content: 'answer' });
      yield chunk({}, 'stop');
    });

    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        model: 'auto', max_tokens: 100, stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    const text = await res.text();
    server.close();

    const events = text.split('\n\n').filter(Boolean).map(block => {
      const evLine = block.split('\n').find(l => l.startsWith('event: '));
      const dataLine = block.split('\n').find(l => l.startsWith('data: '));
      return {
        event: evLine?.slice(7),
        data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
      };
    });

    // Thinking block opens first, text block opens after it closes.
    const blockStarts = events
      .filter(e => e.event === 'content_block_start')
      .map(e => e.data.content_block.type);
    expect(blockStarts).toEqual(['thinking', 'text']);

    // Every reasoning token is forwarded in order, exactly once.
    const thinkingDeltas = events
      .filter(e => e.data?.delta?.type === 'thinking_delta')
      .map(e => e.data.delta.thinking);
    expect(thinkingDeltas).toEqual(['step one', 'step two']);

    // Visible content rides its own text_delta after the thinking block closed.
    const textDeltas = events
      .filter(e => e.data?.delta?.type === 'text_delta')
      .map(e => e.data.delta.text);
    expect(textDeltas).toEqual(['answer']);
  });
});
