import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandCodeProvider } from '../../providers/commandcode.js';

describe('CommandCodeProvider', () => {
  let provider: CommandCodeProvider;

  beforeEach(() => {
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

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return {
        ok: true,
        text: () => Promise.resolve(
          JSON.stringify({ type: 'text-delta', text: 'Hello!' }) + '\n' +
          JSON.stringify({ type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 1 } })
        ),
      } as Response;
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

  it('parses a generate response into an OpenAI chat.completion', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        text: () => Promise.resolve(
          JSON.stringify({ type: 'text-delta', text: 'Hello!' }) + '\n' +
          JSON.stringify({ type: 'text-delta', text: ' World' }) + '\n' +
          JSON.stringify({ type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 2 } })
        ),
      } as Response;
    });

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

  it('throws on an error response', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limit exceeded'),
      } as Response;
    });

    await expect(
      provider.chatCompletion('my-key', [{ role: 'user', content: 'hi' }], 'test-model'),
    ).rejects.toThrow('CommandCode API error 429');
  });
});