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
  describe('validateKey — quota/credit signals are valid, not invalid', () => {
    const mockRes = (status: number, body: string) => ({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    } as Response);

    it('treats a 429 weekly-usage-limit as a valid key', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockRes(429,
        JSON.stringify({ success:false, error:{ code:'RATE_LIMITED', status:429, message:"You've reached your weekly usage limit for your plan. Your limit resets at 2026-07-07T22:52:49.619Z." } })));
      expect(await provider.validateKey('k')).toBe(true);
    });

    it('treats a 400 "insufficient credits" as a valid key', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockRes(400,
        JSON.stringify({ success:false, error:{ code:'BAD_REQUEST', status:400, message:'You have insufficient credits to make this request. Please purchase more credits to continue using the service.' } })));
      expect(await provider.validateKey('k')).toBe(true);
    });

    it('treats a 402 payment-required as a valid key', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockRes(402,
        JSON.stringify({ success:false, error:{ code:'PAYMENT_REQUIRED', status:402, message:'insufficient_quota' } })));
      expect(await provider.validateKey('k')).toBe(true);
    });

    it('still marks a 401 as invalid', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockRes(401,
        JSON.stringify({ success:false, error:{ code:'UNAUTHORIZED', status:401, message:"Invalid 'Authorization' header or token." } })));
      expect(await provider.validateKey('bad')).toBe(false);
    });

    it('does NOT treat a genuine malformed-request 400 as valid', async () => {
      // e.g. a body-schema rejection — must stay invalid so a real config/key
      // mismatch is not hidden behind the quota carve-out.
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockRes(400,
        JSON.stringify({ success:false, error:{ code:'BAD_REQUEST', status:400, message:'Validation error: expected string at "config.gitStatus"' } })));
      expect(await provider.validateKey('k')).toBe(false);
    });

    it('treats a 5xx upstream fault as valid (upstream problem, not the key)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockRes(503, 'upstream unavailable'));
      expect(await provider.validateKey('k')).toBe(true);
    });

    // M23 flipped the old `catch { return true }` semantics: a transport
    // error is no longer a "valid" verdict — it propagates so the health
    // checker classifies the key as a transient 'error' rather than healthy.
    it('propagates transport errors so the checker marks them transient', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(provider.validateKey('k')).rejects.toThrow('ECONNREFUSED');
    });
  });
});