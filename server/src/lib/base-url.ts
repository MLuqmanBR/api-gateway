/**
 * Normalize a custom-provider base URL for OpenAI-compat storage.
 *
 * OpenAICompatProvider builds `${baseUrl}/chat/completions`, so the stored
 * URL must include the API path root (e.g. `/v1`). Many users paste a bare
 * host (`https://api.exampleprovider.dev`) or a non-versioned path and hit 404s
 * because the gateway POSTs to `/chat/completions` directly. When the path
 * has no `/v<digits>` segment, append `/v1`.
 *
 * Anthropic-format providers are the opposite: AnthropicCompatProvider
 * appends `/v1/messages` itself, so their baseUrl must NOT include `/v1`.
 * This helper therefore leaves non-openai URLs untouched (callers gate on
 * api_format).
 *
 * Idempotent: a URL already ending in `/v1` (or any `/vN`) is returned
 * unchanged. A trailing slash is always trimmed first.
 */
export function normalizeOpenAiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  // Append /v1 only when the path has no /v<digits> segment anywhere.
  // This covers bare hosts (https://api.exampleprovider.dev) and host+non-version
  // paths, while leaving /api/v1, /api/paas/v4, /openai/v1, etc. alone.
  if (/\/v\d/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}
