import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@api-gateway/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { contentToString, blockMediaKind, mediaUrlOf } from '../lib/content.js';
import { extractErrorMessage } from '../lib/error-body.js';
const API_BASE = 'https://api.cohere.ai/compatibility/v1';

/**
 * Cohere's compatibility endpoint accepts `{type:'image_url', image_url:{url}}`
 * blocks for image input, and both `data:` and http(s) URLs natively (it does
 * not need the URL fetched for it). Audio and video have no representation in
 * this wire format — those blocks are dropped, and the router's
 * adapter-capability cap keeps them from being routed here at all.
 *
 * Messages with no media stay plain strings: Cohere accepts either form, and
 * the string form is what its API documents for text-only turns.
 */
function toCohereMessages(messages: ChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) {
      return { ...m, content: contentToString(m.content) };
    }
    const parts: Array<Record<string, unknown>> = [];
    let droppedMedia = false;
    for (const block of m.content) {
      const kind = blockMediaKind(block);
      if (!kind) {
        const text = contentToString([block]);
        if (text.length > 0) parts.push({ type: 'text', text });
        continue;
      }
      if (kind !== 'image') { droppedMedia = true; continue; }
      const url = mediaUrlOf(block, kind);
      if (!url) { droppedMedia = true; continue; }
      parts.push({ type: 'image_url', image_url: { url } });
    }
    if (droppedMedia) {
      console.warn(`[cohere] dropped audio/video content block(s) — Cohere supports image input only`);
    }
    // No media survived: fall back to the plain-string form rather than
    // sending an array Cohere has no reason to see.
    if (!parts.some(p => p.type === 'image_url')) {
      return { ...m, content: contentToString(m.content) };
    }
    return { ...m, content: parts };
  });
}

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
      messages: toCohereMessages(messages),
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.max_tokens !== undefined && options.max_tokens > 0) body.max_tokens = options.max_tokens;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.tools?.length) body.tools = options.tools;
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
