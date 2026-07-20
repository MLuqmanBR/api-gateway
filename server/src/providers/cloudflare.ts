import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@api-gateway/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';
import { extractErrorMessage } from '../lib/error-body.js';
/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';

  // The ONLY place a Cloudflare account_id is derived. Given an apiKey it
  // returns the account_id that must be used for THAT key — never a cached or
  // borrowed account. Every outgoing request rebuilds the URL from the exact
  // key it was given, so a key rotation always carries its own account_id.
  static accountIdOf(apiKey: string): string {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be in format "account_id:api_token"');
    return apiKey.slice(0, sep);
  }

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be in format "account_id:api_token"');
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  // Cloudflare's OpenAI-compat endpoint:
  //   - rejects `content: null` on assistant messages that carry tool_calls,
  //     even though the OpenAI spec allows it (collapse to '');
  //   - doesn't accept the array content envelope, so flatten to string.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m => ({ ...m, content: contentToString(m.content) }));
  }

  /** Assemble the request body shared by both call paths. Thinking knobs
   * are forwarded verbatim — Cloudflare silently drops fields it doesn't
   * recognize, but newer reasoning models (DeepSeek R1 distill etc.) read
   * `reasoning_effort` and pick the right depth. (#290) */
  private buildBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream = false,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: this.normalizeMessages(messages),
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.tools) body.tools = options.tools;
    if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;
    if (options?.parallel_tool_calls !== undefined) body.parallel_tool_calls = options.parallel_tool_calls;
    if (options?.reasoning_effort) body.reasoning_effort = options.reasoning_effort;
    if (options?.thinking) body.thinking = options.thinking;
    if (stream) body.stream = true;
    return body;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(messages, modelId, options)),
    }, 120000, options?.abortSignal);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(messages, modelId, options, true)),
    }, 120000, options?.abortSignal);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cloudflare API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`);
    }

    yield* this.readSseStream(res, 300000, options?.abortSignal);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    const { token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
    // Cloudflare's token-verify response is a narrow shape; we only check
    // `success` and `result.status` per the documented contract. Anything
    // else we treat as "key not verified by this transport" rather than
    // disabling it. Use `unknown` instead of `any` so the API stays typed:
    // the cast through `unknown` is a one-way boundary at the JSON-parse
    // gateway, which is the only safe place to lose tracking. (#290)
    const data = await res.json().catch(() => null) as unknown as { success?: unknown; result?: { status?: unknown } } | null;
    return data?.success === true && data.result?.status === 'active';
  }
}
