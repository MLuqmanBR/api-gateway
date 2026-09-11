import type { ChatCompletionChunk } from '@api-gateway/shared/types.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandCodeProvider, resetCommandCodeSessionState } from '../../providers/commandcode.js';

/** NDJSON generate response assembled from CC stream events. */
function ndjson(...events: Record<string, unknown>[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

function ndjsonResponse(payload: string): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    text: () => Promise.resolve(payload),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  } as unknown as Response;
}

/** Mock that answers the version/fingerprint/lifecycle pre-requests and
 *  routes `/alpha/generate` calls to the given handler. */
function mockGenerate(
  handler: (body: Record<string, unknown>, headers: Record<string, string>, call: number) => Response | Promise<Response>,
): void {
  let generateCalls = 0;
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const headers = ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
    if (url.includes('registry.npmjs.org')) {
      return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }) } as Response;
    }
    if (url.includes('/alpha/fingerprint/record') || url.includes('/alpha/lifecycle-events')) {
      return { ok: true, body: undefined } as unknown as Response;
    }
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    if (url.includes('/alpha/generate')) {
      generateCalls += 1;
      return await handler(body, headers, generateCalls);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('CommandCodeProvider', () => {
  let provider: CommandCodeProvider;

  beforeEach(() => {
    resetCommandCodeSessionState();
    provider = new CommandCodeProvider({
      platform: 'commandcode',
      name: 'CommandCode',
    });
  });

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('commandcode');
    expect(provider.name).toBe('CommandCode');
  });

  it('translates messages to CommandCode content-part format', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    mockGenerate((body) => {
      capturedBody = body;
      return ndjsonResponse(ndjson(
        { type: 'text-delta', text: 'Hello!' },
        { type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 1 } },
      ));
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'Say hi' }], 'deepseek/deepseek-v4-pro');

    expect(capturedBody).not.toBeNull();
    const params = capturedBody!['params'] as Record<string, unknown>;
    expect(params['model']).toBe('deepseek/deepseek-v4-pro');
    expect(Array.isArray(params['messages'])).toBe(true);

    const msgs = params['messages'] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content[0].type).toBe('text');
    expect(msgs[0].content[0].text).toBe('Say hi');

    // system role is extracted from messages list
    expect(typeof params['system']).toBe('string');
  });

  it('sends the single-space system placeholder when there is no system message', async () => {
    let capturedParams: Record<string, unknown> | null = null;
    mockGenerate((body) => {
      capturedParams = body['params'] as Record<string, unknown>;
      return ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } }));
    });

    // Upstream injects ~7.5K tokens of its own system prompt when
    // params.system is absent/empty — the space placeholder suppresses it.
    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash');
    expect(capturedParams!['system']).toBe(' ');
  });

  it('forwards image parts as CommandCode image blocks (all input shapes)', async () => {
    let capturedMessages: Array<{ role: string; content: Array<Record<string, unknown>> }> | null = null;
    mockGenerate((body) => {
      capturedMessages = body['params'] && (body['params'] as Record<string, unknown>)['messages'] as typeof capturedMessages;
      return ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } }));
    });

    const dataUri = 'data:image/png;base64,AAAA';
    await provider.chatCompletion('my-key', [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: dataUri } },          // OpenAI object form
        { type: 'image_url', image_url: 'https://example.com/x.png' }, // shorthand form
        { type: 'image', image: dataUri },                            // google-style form
        { type: 'input_image', image_url: dataUri },                  // Responses-style form
      ],
    }], 'xiaomi/mimo-v2.5');

    expect(capturedMessages).not.toBeNull();
    const parts = capturedMessages![0].content;
    const images = parts.filter(p => p['type'] === 'image');
    expect(images.length).toBe(4);
    for (const img of images) {
      expect(typeof img['image']).toBe('string');
      expect(String(img['image']).length).toBeGreaterThan(0);
    }
    // no "[Image URL: ...]" stringification
    expect(JSON.stringify(parts)).not.toContain('[Image URL');
  });

  it('maps tool_choice strings and objects to the Anthropic-style shape', async () => {
    const captured: Record<string, unknown>[] = [];
    mockGenerate((body) => {
      captured.push(body['params'] as Record<string, unknown>);
      return ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } }));
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { tool_choice: 'required', parallel_tool_calls: false });
    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { tool_choice: { type: 'function', function: { name: 'get_weather' } } });

    expect(captured[0]['tool_choice']).toEqual({ type: 'any' });
    expect(captured[0]['parallel_tool_calls']).toBe(false);
    expect(captured[1]['tool_choice']).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('normalizes reasoning efforts and never forwards the thinking object', async () => {
    const captured: Record<string, unknown>[] = [];
    mockGenerate((body) => {
      captured.push(body['params'] as Record<string, unknown>);
      return ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } }));
    });

    // gateway-only 'minimal' → upstream enum 'low'
    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { reasoning_effort: 'minimal' });
    // rich thinking object → effort extracted, object NOT forwarded
    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { thinking: { type: 'enabled', effort: 'xhigh' } });
    // disabled → no reasoning_effort at all (upstream has no disable path)
    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { thinking: { type: 'disabled' } });

    expect(captured[0]['reasoning_effort']).toBe('low');
    expect(captured[1]['reasoning_effort']).toBe('xhigh');
    expect(captured[1]['thinking']).toBeUndefined();
    expect(captured[2]['reasoning_effort']).toBeUndefined();
    expect(captured[2]['thinking']).toBeUndefined();
  });

  it('sends the anti-detection session headers on generate requests', async () => {
    let capturedHeaders: Record<string, string> | null = null;
    mockGenerate((_body, headers) => {
      capturedHeaders = headers;
      return ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } }));
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash');

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!['x-session-id']).toMatch(/[0-9a-f-]{36}/);
    expect(capturedHeaders!['x-co-flag']).toBe('false');
    expect(capturedHeaders!['x-taste-learning']).toBe('false');
    expect(capturedHeaders!['x-project-slug']).toMatch(/^users-dev-projects-[a-z]+-[0-9a-f]{4}$/);
    expect(capturedHeaders!['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('zeros the usage when a finish event reports no output tokens', async () => {
    mockGenerate(() => ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 100, outputTokens: 0 } })));

    const result = await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash');

    // anti false-billing: a glitched response with no output must not bill
    // the prompt either
    expect(result.usage?.prompt_tokens).toBe(0);
    expect(result.usage?.completion_tokens).toBe(0);
  });

  it('parses a generate response into an OpenAI chat.completion', async () => {
    mockGenerate(() => ndjsonResponse(ndjson(
      { type: 'text-delta', text: 'Hello!' },
      { type: 'text-delta', text: ' World' },
      { type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 2 } },
    )));

    const result = await provider.chatCompletion('my-key', [{ role: 'user', content: 'Say hi' }], 'deepseek/deepseek-v4-pro');

    expect(result.object).toBe('chat.completion');
    expect(result._routed_via).toBeDefined();
    expect(result._routed_via!.platform).toBe('commandcode');
    expect(result._routed_via!.model).toBe('deepseek/deepseek-v4-pro');

    const choice = result.choices[0];
    expect(choice.message.content).toBe('Hello! World');
    expect(choice.finish_reason).toBe('stop');

    expect(result.usage?.prompt_tokens).toBe(5);
    expect(result.usage?.completion_tokens).toBe(2);
    expect(result.usage?.total_tokens).toBe(7);
  });

  it('streams reasoning and content deltas with a terminal usage frame', async () => {
    mockGenerate(() => ndjsonResponse(ndjson(
      { type: 'reasoning-delta', reasoning_content: 'pondering' },
      { type: 'text-delta', text: 'PONG' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 9, outputTokens: 4 } },
    )));

    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of provider.streamChatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash')) {
      chunks.push(chunk);
    }
    const reasoning = chunks.find(c => c.choices[0]?.delta && 'reasoning_content' in c.choices[0].delta);
    expect(reasoning?.choices[0].delta).toMatchObject({ role: 'assistant', reasoning_content: 'pondering' });

    const content = chunks.find(c => c.choices[0]?.delta && 'content' in c.choices[0].delta);
    expect(content?.choices[0].delta).toMatchObject({ content: 'PONG' });

    const finish = chunks.find(c => c.choices[0]?.finish_reason != null);
    expect(finish?.choices[0].finish_reason).toBe('stop');
    expect(finish?.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 4 });
  });

  it('throws on an error response', async () => {
    mockGenerate(() => ({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limit exceeded'),
    } as Response));

    await expect(
      provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'test-model'),
    ).rejects.toThrow('CommandCode API error 429');
  });

  it('retries once without a param the upstream 400 names, then never sends it again', async () => {
    const generateBodies: Record<string, unknown>[] = [];
    mockGenerate((body) => {
      generateBodies.push(body['params'] as Record<string, unknown>);
      if (generateBodies.length === 1) {
        return {
          ok: false,
          status: 400,
          text: () => Promise.resolve('Validation error: Unrecognized key: "params.tool_choice"'),
        } as Response;
      }
      return ndjsonResponse(ndjson({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } }));
    });

    const result = await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { tool_choice: 'auto' });
    expect(result.object).toBe('chat.completion');

    expect(generateBodies.length).toBe(2);
    expect(generateBodies[0]['tool_choice']).toEqual({ type: 'auto' });
    expect(generateBodies[1]['tool_choice']).toBeUndefined();

    // process-lifetime memo: the next request omits the field from the start
    await provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', { tool_choice: 'auto' });
    expect(generateBodies.length).toBe(3);
    expect(generateBodies[2]['tool_choice']).toBeUndefined();
  });

  describe('validateKey — quota/credit signals are valid, not invalid', () => {
    const mockRes = (status: number, body: string) => ({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    } as Response);

    it('treats a 429 weekly-usage-limit as a valid key', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/alpha/generate')) {
          return mockRes(429, JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', status: 429, message: "You've reached your weekly usage limit for your plan. Your limit resets at 2026-07-07T22:52:49.619Z." } }));
        }
        return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }), body: undefined } as unknown as Response;
      });
      expect(await provider.validateKey('k')).toBe(true);
    });

    it('treats a 400 "insufficient credits" as a valid key', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/alpha/generate')) {
          return mockRes(400, JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', status: 400, message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.' } }));
        }
        return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }), body: undefined } as unknown as Response;
      });
      expect(await provider.validateKey('k')).toBe(true);
    });

    it('treats a 402 payment-required as a valid key', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/alpha/generate')) {
          return mockRes(402, JSON.stringify({ success: false, error: { code: 'PAYMENT_REQUIRED', status: 402, message: 'insufficient_quota' } }));
        }
        return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }), body: undefined } as unknown as Response;
      });
      expect(await provider.validateKey('k')).toBe(true);
    });

    it('still marks a 401 as invalid', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/alpha/generate')) {
          return mockRes(401, JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', status: 401, message: "Invalid 'Authorization' header or token." } }));
        }
        return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }), body: undefined } as unknown as Response;
      });
      expect(await provider.validateKey('bad')).toBe(false);
    });

    it('does NOT treat a genuine malformed-request 400 as valid', async () => {
      // e.g. a body-schema rejection — must stay invalid so a real config/key
      // mismatch is not hidden behind the quota carve-out.
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/alpha/generate')) {
          return mockRes(400, JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', status: 400, message: 'Validation error: expected string at "config.gitStatus"' } }));
        }
        return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }), body: undefined } as unknown as Response;
      });
      expect(await provider.validateKey('k')).toBe(false);
    });

    it('treats a 5xx upstream fault as valid (upstream problem, not the key)', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/alpha/generate')) {
          return mockRes(503, 'upstream unavailable');
        }
        return { ok: true, json: () => Promise.resolve({ version: '0.18.10' }), body: undefined } as unknown as Response;
      });
      expect(await provider.validateKey('k')).toBe(true);
    });

    // M23 flipped the old `catch { return true }` semantics: a transport
    // error is no longer a "valid" verdict — it propagates so the health
    // checker classifies the key as a transient 'error' rather than healthy.
    it('propagates transport errors so the checker marks them transient', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(provider.validateKey('k')).rejects.toThrow('ECONNREFUSED');
    });
  });
});
