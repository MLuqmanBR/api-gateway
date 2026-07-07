import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

describe('CloudflareProvider key/account_id pairing', () => {
  let provider: CloudflareProvider;

  beforeEach(() => {
    provider = new CloudflareProvider();
    vi.restoreAllMocks();
  });

  it('accountIdOf returns the account_id from a valid account_id:token key', () => {
    expect(CloudflareProvider.accountIdOf('acct123:my-token')).toBe('acct123');
  });

  it('accountIdOf throws on malformed key (no colon)', () => {
    expect(() => CloudflareProvider.accountIdOf('no-colon')).toThrow(/account_id:api_token/);
  });

  it('chatCompletion uses the key\'s own account_id in URL and its token in Authorization', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as RequestInit & { headers: Record<string, string> }).headers as Record<string, string>;
      capturedBody = JSON.parse((init as RequestInit & { body: string }).body ?? '{}');
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      } as Response;
    });

    await provider.chatCompletion(
      'acct-A:token-A',
      [{ role: 'user', content: 'Hi' }],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedUrl).toContain('accounts/acct-A/');
    expect(capturedHeaders['Authorization']).toBe('Bearer token-A');
  });

  it('rotate to second key uses its own account_id and token (pairing invariant)', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({
        url: url as string,
        headers: (init as RequestInit & { headers: Record<string, string> }).headers as Record<string, string>,
      });
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as Response;
    });

    await provider.chatCompletion('acct-A:token-A', [{ role: 'user', content: 'A' }], 'model');
    await provider.chatCompletion('acct-B:token-B', [{ role: 'user', content: 'B' }], 'model');

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('accounts/acct-A/');
    expect(calls[0].headers['Authorization']).toBe('Bearer token-A');
    expect(calls[1].url).toContain('accounts/acct-B/');
    expect(calls[1].headers['Authorization']).toBe('Bearer token-B');
    expect(calls[0].url).not.toContain('acct-B');
    expect(calls[1].url).not.toContain('acct-A');
  });

  it('streamChatCompletion pairs account_id with its own token on every chunk', async () => {
    const chunks: Array<{ url: string; headers: Record<string, string> }> = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      chunks.push({
        url: url as string,
        headers: (init as RequestInit & { headers: Record<string, string> }).headers as Record<string, string>,
      });
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"id":"c","choices":[{"delta":{}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as Response;
    });

    const gen = provider.streamChatCompletion('acct-X:tok-X', [{ role: 'user', content: 'stream' }], 'model');
    for await (const _ of gen) {
      // consume
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].url).toContain('accounts/acct-X/');
    expect(chunks[0].headers['Authorization']).toBe('Bearer tok-X');
  });

  it('streamChatCompletion rotation keeps account/token paired', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({
        url: url as string,
        headers: (init as RequestInit & { headers: Record<string, string> }).headers as Record<string, string>,
      });
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"id":"c","choices":[{"delta":{}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as Response;
    });

    for await (const _ of provider.streamChatCompletion('acct-1:tok-1', [{ role: 'user', content: '1' }], 'model')) {}
    for await (const _ of provider.streamChatCompletion('acct-2:tok-2', [{ role: 'user', content: '2' }], 'model')) {}

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('accounts/acct-1/');
    expect(calls[0].headers['Authorization']).toBe('Bearer tok-1');
    expect(calls[1].url).toContain('accounts/acct-2/');
    expect(calls[1].headers['Authorization']).toBe('Bearer tok-2');
  });

  it('validateKey uses the key\'s own token (no account_id in token-verify URL)', async () => {
    let capturedUrl = '';

    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      capturedUrl = url as string;
      return {
        ok: true,
        json: () => Promise.resolve({ success: true, result: { status: 'active' } }),
      } as Response;
    });

    await provider.validateKey('acct-ver:token-ver');

    expect(capturedUrl).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
  });

  it('throws on malformed key before any network call', async () => {
    const spy = vi.spyOn(global, 'fetch');
    await expect(
      provider.chatCompletion('no-colon', [{ role: 'user', content: 'x' }], 'model'),
    ).rejects.toThrow(/account_id:api_token/);
    expect(spy).not.toHaveBeenCalled();
  });
});