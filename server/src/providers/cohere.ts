import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@api-gateway/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { flattenMessageContent } from '../lib/content.js';
import { extractErrorMessage } from '../lib/error-body.js';
const API_BASE = 'https://api.cohere.ai/compatibility/v1';

export class CohereProvider extends BaseProvider {
  readonly platform = 'cohere' as const;
  readonly name = 'Cohere';
  baseUrl = API_BASE;

  /** Assemble the request body shared by both call paths. Cohere's Chat
   * API ignores unknown fields, so `reasoning_effort` and the rich
   * `thinking` object are forwarded verbatim — a future model/route that
   * understands them decides; the rest is silently dropped upstream. (#290) */
  private buildBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream = false,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.tools) body.tools = options.tools;
    if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;
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
    const body = this.buildBody(messages, modelId, options);

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 60000, options?.abortSignal);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cohere API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`);
    }
    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body = this.buildBody(messages, modelId, options, true);

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 60000, options?.abortSignal);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cohere API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`);
    }

    yield* this.readSseStream(res, 300000, options?.abortSignal);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }
}
