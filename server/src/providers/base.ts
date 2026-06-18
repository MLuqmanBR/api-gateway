import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@api-gateway/shared/types.js';

/** A provider HTTP error carrying the upstream status and, when the response
 *  included a Retry-After header, the parsed delay so the router can bench the
 *  key for at least that long. */
export interface ProviderHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay. Returns undefined when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Build an error for a non-OK upstream response, capturing the status and any
 *  Retry-After hint. Used by every provider adapter so the proxy can honor a
 *  provider's explicit back-off when it sets the cooldown. */
export function providerHttpError(res: Response, message: string): ProviderHttpError {
  const err = new Error(message) as ProviderHttpError;
  err.status = res.status;
  const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  // OpenAI-compat reasoning effort level (mapped per-provider to the wire
  // shape that controls thinking depth). Optional — providers that don't
  // support thinking ignore it. (#290)
  reasoning_effort?: 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal';
  // Richer thinking-control object. Providers translate into their native
  // vocab (`thinking`, `thinkingConfig`, `reasoning_effort`). See #290.
  thinking?: import('@api-gateway/shared/types.js').ThinkingConfig;
  /** Per-call HTTP timeout override. Not part of the OpenAI wire format (it is
   * stripped before the request body is built); used by the probe script so
   * NVIDIA's 15-60s serverless cold starts don't read as failures. */
  timeoutMs?: number;
  /** Caller-controlled abort signal tied to the client connection. When the
   *  agent presses Stop / closes the session, the proxy aborts this signal so
   *  the in-flight upstream `fetch` (and any mid-stream read) is cancelled
   *  immediately instead of grinding through the rest of the retry/recovery
   *  loop. Thrown rejections are `RequestAbortError` instances — the proxy
   *  catches them and ends the response silently. (#292) */
  abortSignal?: AbortSignal;
}

/** Thrown when a request is cancelled via the caller's `abortSignal` (the
 *  client disconnected). Distinct from a provider HTTP error and from a
 *  timeout so the proxy can tell "user stopped the request" apart from "the
 *  upstream failed" and end the response without logging a failure or
 *  burning another retry. (#292) */
export class RequestAbortError extends Error {
  readonly aborted = true;
  constructor(message = 'request aborted by client') {
    super(message);
    this.name = 'RequestAbortError';
  }
}

/** True for any abort — either our `RequestAbortError` or the native
 *  `DOMException`/`AbortError` that `fetch` rejects with when its `signal`
 *  fires. We surface our own class so the retry loop can distinguish a clean
 *  client-stop from a transport hiccup, but accept either shape defensively
 *  since some runtimes reject with the bare DOMException. (#292) */
export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestAbortError) return true;
  if (err instanceof Error) {
    const name = err.name;
    return name === 'AbortError' || /aborted/i.test(err.message);
  }
  return false;
}

/** Combine an external caller-controlled abort signal with a timeout into a
 *  single signal that fires when EITHER source aborts. Returns the timeout
 *  signal directly when there's no external signal (preserving the original
 *  behavior). The returned controller is owned by the caller, which must
 *  clear the timeout once the fetch settles. (#292) */
function linkAbortAndTimeout(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      clearTimeout(timeout);
      controller.abort();
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const cleanup = () => {
    clearTimeout(timeout);
    if (external) external.removeEventListener('abort', onExternalAbort);
  };
  return { signal: controller.signal, cleanup, timedOut: () => timedOut };
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
   * When true, the gateway stores a sentinel key row so routing still considers
   * the platform "configured", and the provider omits the Authorization header
   * on outgoing requests. Defaults to false; set by subclasses. */
  keyless = false;
  /** Providers whose models endpoint follows the OpenAI /v1/models convention
   * can expose their base URL so the custom-model auto-discovery route knows
   * where to probe. Providers that construct the URL from key contents (e.g.
   * Cloudflare Workers AI — account_id embedded in the key) leave this empty. */
  baseUrl?: string;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string): Promise<boolean>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 60000,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const { signal, cleanup, timedOut } = linkAbortAndTimeout(externalSignal, timeoutMs);
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      // Distinguish "the client stopped the request" from "we hit the
      // timeout". The proxy's retry loop treats a client abort as terminal
      // (no more retries, silent end); a timeout stays a retryable error.
      // (#292)
      if (!timedOut() && externalSignal?.aborted) {
        throw new RequestAbortError();
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Shared SSE reader for OpenAI-wire streaming endpoints (#231 audit).
   *
   * Hardened against the upstream failure modes observed live:
   *  - Inactivity timeout: fetchWithTimeout's abort timer dies the moment
   *    response HEADERS arrive, so a provider that stalls mid-body used to
   *    hang the client forever. Each read now has its own deadline.
   *  - Abrupt EOF: a stream that ends without `[DONE]` AND without any
   *    `finish_reason` is a truncated generation, not a completion. It used
   *    to end the generator silently (truncation logged as success); it now
   *    throws a retryable error so the proxy can fail over or report it.
   *    Providers that skip `[DONE]` but do send a terminal finish_reason
   *    (several compat shims) still complete normally.
   *
   * Malformed data lines are skipped, matching previous behavior.
   */
  protected async *readSseStream(
    res: Response,
    inactivityTimeoutMs = 300000,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let sawFinishReason = false;

    // A client disconnect mid-stream must cancel the upstream read
    // immediately rather than waiting for the inactivity timer (which is
    // 300s) or the provider's own EOF. We attach once and reject the pending
    // read via the race below. (#292)
    if (abortSignal?.aborted) throw new RequestAbortError();
    let aborted = false;
    const onAbort = () => { aborted = true; };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (aborted) throw new RequestAbortError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${this.name} stream stalled: no data for ${inactivityTimeoutMs}ms (timeout)`)),
              inactivityTimeoutMs,
            );
          }),
          // Resolve-reject pair: if the client aborts, this rejects first and
          // the pending `reader.read()` is cancelled in `finally`. (#292)
          ...(abortSignal ? [new Promise<never>((_, reject) => {
            abortSignal.addEventListener('abort', () => reject(new RequestAbortError()), { once: true });
          })] : []),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result;
        if (done) {
          buffer += decoder.decode(); // flush remaining buffered bytes
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionChunk;
            if (chunk.choices?.some(c => c.finish_reason != null)) sawFinishReason = true;
            yield chunk;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!sawFinishReason) {
      throw new Error(`${this.name} stream ended unexpectedly (no [DONE], no finish_reason) — connection reset or truncated upstream`);
    }
  }
}
