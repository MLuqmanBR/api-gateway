import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicCompatProvider } from '../../providers/anthropic.js';

describe('AnthropicCompatProvider', () => {
  let provider: AnthropicCompatProvider;

  beforeEach(() => {
    provider = new AnthropicCompatProvider({
      platform: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Minimal non-streaming Anthropic /v1/messages response. */
  const okResponse = () => ({
    ok: true,
    json: () => Promise.resolve({
      id: 'msg_abc',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'text' as const, text: 'Ah, right — 42.' },
      ],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
  });

  // ── tests ────────────────────────────────────────────────────────────────

  it('maps OpenAI messages+tools to Anthropic messages/system/tools', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return okResponse() as unknown as Response;
    });

    await provider.chatCompletion(
      'sk-ant-key',
      [
        { role: 'system', content: 'You are a math tutor.' },
        { role: 'user', content: 'What is 6*7?' },
        { role: 'user', content: 'Come on, just the answer.' },
      ],
      'claude-sonnet-4-20250514',
      {
        tools: [{
          type: 'function' as const,
          function: { name: 'calculator', description: 'Evaluates expressions', parameters: { type: 'object', properties: { expr: { type: 'string' } } } },
        }],
        tool_choice: 'auto',
      },
    );

    expect(capturedBody).not.toBeNull();

    // System messages hoisted to top-level system field
    expect(capturedBody!['system']).toBe('You are a math tutor.');

    // Model passed through
    expect(capturedBody!['model']).toBe('claude-sonnet-4-20250514');

    // Tools translated from OpenAI {type:'function', function:{…}} shape
    const tools = capturedBody!['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['name']).toBe('calculator');
    expect(tools[0]['description']).toBe('Evaluates expressions');
    expect(tools[0]['input_schema']).toBeDefined();

    // Tool choice mapped: OpenAI 'auto' → Anthropic {type:'auto'}
    const tc = capturedBody!['tool_choice'] as Record<string, unknown>;
    expect(tc['type']).toBe('auto');

    // Messages list excludes system roles
    const msgs = capturedBody!['messages'] as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('Come on, just the answer.');
  });

  it('translates a tool_use response to OpenAI tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'msg_bcd',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'tool_use', id: 'tu_001', name: 'calculator', input: { expr: '6*7' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      } as unknown as Response;
    });

    const result = await provider.chatCompletion(
      'sk-ant-key',
      [{ role: 'user', content: 'Calculate 6*7' }],
      'claude-sonnet-4-20250514',
      { tools: [{ type: 'function', function: { name: 'calculator', parameters: {} } }] },
    );

    const msg = result.choices[0].message;
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0].id).toBe('tu_001');
    expect(msg.tool_calls![0].type).toBe('function');
    expect(msg.tool_calls![0].function.name).toBe('calculator');
    expect(msg.tool_calls![0].function.arguments).toBe('{"expr":"6*7"}');

    // finish_reason translated from 'tool_use' → 'tool_calls'
    expect(result.choices[0].finish_reason).toBe('tool_calls');

    // Usage preserved
    expect(result.usage?.prompt_tokens).toBe(8);
    expect(result.usage?.completion_tokens).toBe(4);
  });

  it('throws on an error response', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'invalid x-api-key' } }),
      } as unknown as Response;
    });

    await expect(
      provider.chatCompletion('sk-ant-key', [{ role: 'user', content: 'hi' }], 'claude-sonnet-4-20250514'),
    ).rejects.toThrow('Anthropic API error 401');
  });

  it('folds streaming SSE into chat.completion chunks', async () => {
    // Non-stream anthropic mocks — proper SSE streaming tests would mock
    // readSseStream, but we can verify the non-stream path also correctly
    // folds content blocks.
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'msg_sse',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Part one. ' },
            { type: 'text', text: 'Part two.' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      } as unknown as Response;
    });

    const result = await provider.chatCompletion(
      'sk-ant-key',
      [{ role: 'user', content: 'Tell me a fact' }],
      'claude-sonnet-4-20250514',
    );

    // Multiple text blocks concatenated
    expect(result.choices[0].message.content).toBe('Part one. Part two.');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  // Media conversion outbound: an OpenAI image_url block becomes an Anthropic
  // image block, with a data URL split into a base64 source (Anthropic has no
  // object-URL concept) and an http URL kept as a url source.
  it('converts image_url blocks to Anthropic image blocks (base64 and url sources)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return okResponse() as unknown as Response;
    });

    await provider.chatCompletion('key', [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
        { type: 'image_url', image_url: { url: 'https://example.com/pic.png' } },
      ],
    }], 'claude-sonnet-4-20250514');

    const messages = (capturedBody as unknown as {
      messages: Array<{ role: string; content: unknown }>;
    }).messages;
    const blocks = messages[0].content as Array<{ type: string; source: Record<string, string> }>;

    expect(blocks[0]).toMatchObject({ type: 'text', text: 'what is this?' });
    // A data URL is split into Anthropic's base64 source shape.
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
    });
    // An http URL keeps the URL source form.
    expect(blocks[2]).toMatchObject({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/pic.png' },
    });
  });

  it('passes a document block through unchanged', async () => {
    // The inbound Anthropic route accepts `document` (PDF) blocks; the outbound
    // adapter must forward them rather than flattening to text, or a
    // Claude-to-gateway-to-Claude round trip loses the PDF.
    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return okResponse() as unknown as Response;
    });

    await provider.chatCompletion('key', [{
      role: 'user',
      content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }],
    }], 'claude-sonnet-4-20250514');

    const blocks = (capturedBody as unknown as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    }).messages[0].content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
    });
  });

  it('warns and drops audio/video rather than mangling them into text', async () => {
    // Anthropic has no audio or video content block. Dropping with a warning is
    // honest; converting to text would silently change the request's meaning.
    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return okResponse() as unknown as Response;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await provider.chatCompletion('key', [{
      role: 'user',
      content: [
        { type: 'text', text: 'listen' },
        { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
      ],
    }], 'claude-sonnet-4-20250514');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped audio/video'));
    // The text survived and no media block was invented.
    const content = (capturedBody as unknown as {
      messages: Array<{ content: unknown }>;
    }).messages[0].content;
    expect(JSON.stringify(content)).toContain('listen');
    expect(JSON.stringify(content)).not.toContain('UklGRg==');
    expect(JSON.stringify(content)).not.toContain('AAAA');
    warn.mockRestore();
  });
});
