// Batch audio transcription/translation routing. Mirrors the embeddings
// service's family-chain + per-key failover design: a "family" is one model
// identity (e.g. whisper-large-v3-turbo) and failover only walks providers
// serving that same family — a different model could return a different
// transcript dialect, so the family is the routing unit.
//
// `model: "auto"` (or empty) routes to the configured default family.
//
// Unlike embeddings, transcription ALSO honors the client-key model
// allowlist: the chain is filtered to rows admitted by isModelAllowed before
// any dispatch, so a scoped key cannot reach an unlisted audio model.
import { getDb, getSetting } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { isModelAllowed } from '../lib/client-keys.js';
import { buildProviderFor } from '../providers/index.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';

export interface TranscriptionModelRow {
  id: number;
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  max_file_mb: number;
  supports_translations: number;
  price_per_hour_usd: number | null;
  priority: number;
  enabled: number;
  quota_label: string;
  /** Wire shape this provider expects: multipart (OpenAI default) or a
   *  base64 JSON body. */
  shape: string;
  /** 1 when this row has a resolvable audio endpoint. 0 renders a badge in
   *  the dashboard instead of failing at request time. */
  audio_endpoint: number;
}

export class TranscriptionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// undici-types' FormDataEntryValue (File | string) — not declared as a
// global by @types/node, so re-stated here.
type MultipartValue = File | string;

export function listTranscriptionModels(): TranscriptionModelRow[] {
  return getDb().prepare(
    'SELECT * FROM transcription_models ORDER BY family, priority',
  ).all() as TranscriptionModelRow[];
}

export function getDefaultFamily(): string {
  return getSetting('transcriptions_default_family') ?? 'whisper-large-v3-turbo';
}

/** Map the request's `model` to a family: 'auto'/empty → default; a family
 * name → itself; a provider-specific model id → its family. */
export function resolveFamily(model: string | undefined): string | null {
  if (!model || model === 'auto') return getDefaultFamily();
  const rows = listTranscriptionModels();
  if (rows.some(r => r.family === model)) return model;
  const byModelId = rows.find(r => r.model_id === model);
  return byModelId?.family ?? null;
}

/** Resolve the request's `model` to a concrete row (default family's first
 * enabled provider when 'auto'/empty; the row behind a family name or a bare
 * provider model id). Null → the route 400s. */
export function resolveTranscriptionModel(input: string): TranscriptionModelRow | null {
  const family = resolveFamily(input);
  if (!family) return null;
  const rows = getDb().prepare(
    'SELECT * FROM transcription_models WHERE family = ? ORDER BY priority',
  ).all(family) as TranscriptionModelRow[];
  return rows[0] ?? null;
}

// Audio is billed by duration, not tokens. Integer cents to match
// checkAndReserve's currency.
export function estimateTranscriptionCostCents(usdPerHour: number, seconds: number): number {
  return Math.ceil((seconds / 3600) * usdPerHour * 100);
}

/**
 * Usable keys for a platform, with their row ids.
 *
 * The id travels with the secret so the request log can attribute the call
 * (`requests.key_id`) — chat does this and audio previously did not, which
 * made per-key audio spend invisible. Keyless providers store a `'no-key'`
 * sentinel row (routes/keys.ts), which this query returns like any other, so
 * keyless audio platforms resolve a key instead of silently skipping.
 */
function getPlatformKeys(platform: string): Array<{ id: number; key: string }> {
  const rows = getDb().prepare(
    "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY id",
  ).all(platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string }[];
  const keys: Array<{ id: number; key: string }> = [];
  for (const row of rows) {
    try {
      keys.push({ id: row.id, key: decrypt(row.encrypted_key, row.iv, row.auth_tag) });
    } catch {
      // skip undecryptable rows
    }
  }
  return keys;
}

const FETCH_TIMEOUT_MS = 120_000;

export interface TranscriptionCall {
  kind: 'transcriptions' | 'translations';
  /** Raw client `model` value ('' → auto). */
  model: string;
  /** Every parsed multipart entry except the file — order and repeats
   * preserved (e.g. repeated `timestamp_granularities[]`). `model` and
   * `stream` are consumed by the parser and never appear here. */
  fields: Array<[string, MultipartValue]>;
  file: File;
  /** Client-key model allowlist (audio enforcement); null/undefined/empty =
  *  unrestricted or unified key. */
  clientModelAllowlist?: string[] | null;
}

export interface TranscriptionResult {
  status: number;
  /** Verbatim upstream JSON text. */
  body: string;
  /** Winner row — the caller uses its price for budget reconciliation. */
  row: TranscriptionModelRow;
  /** usage.prompt_audio_seconds (mistral) / duration (groq verbose_json);
   *  null when the provider reported neither. */
  actualSeconds: number | null;
}

/** Parse result of parseAudioRequest. */
export interface ParsedAudioRequest {
  fields: Array<[string, MultipartValue]>;
  file: File | null;
  model: string;
  stream: boolean;
}

/** Parse a raw multipart body via the bundled-undici Request.formData(). The
 *  first File-valued entry is the file; `model`/`stream` are read from string
 *  entries and returned separately (the service rewrites model from the
 *  catalog row and never forwards stream). */
export async function parseAudioRequest(contentType: string, body: Buffer): Promise<ParsedAudioRequest> {
  const form = await new Request('http://localhost', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  }).formData();
  const fields: Array<[string, MultipartValue]> = [];
  let file: File | null = null;
  let model = '';
  let stream = false;
  for (const [key, value] of form.entries()) {
    if (typeof value === 'object' && file === null) {
      file = value as File;
      continue;
    }
    if (typeof value === 'object') {
      // A second file part — forward it verbatim as an extra field; the
      // provider will reject it if it cares. Only the first is the file.
      fields.push([key, value]);
      continue;
    }
    if (key === 'model') { model = value; continue; }
    if (key === 'stream') { stream = value === 'true' || value === '1'; continue; }
    fields.push([key, value]);
  }
  return { fields, file, model, stream };
}

/**
 * Fields a platform rejects even though the OpenAI audio spec allows them.
 * Keyed by platform so one table covers every provider without a code branch.
 */
const STRIPPED_FIELDS: Record<string, Record<string, true>> = {
  mistral: { prompt: true, response_format: true },
};

/**
 * Resolve the audio endpoint for a platform from its provider base URL.
 *
 * Audio is OpenAI-shaped on almost every provider the catalog knows, so the
 * endpoint is simply `${baseUrl}/audio/${kind}` — and every base URL in the
 * live catalog already carries its `/v1` segment (logfare, tokenrouter,
 * aihubmix, unorouter; openrouter, ovh, zhipu, groq, mistral), because chat
 * needs it too. `normalizeOpenAiBaseUrl` guarantees that invariant at every
 * write site, so no per-platform endpoint table is needed and a newly added
 * provider becomes audio-capable by being discoverable.
 *
 * Returns null when the platform has no resolvable base URL (a bespoke
 * adapter with no HTTP endpoint, or an unregistered slug).
 */
export function resolveAudioEndpoint(platform: string, kind: 'transcriptions' | 'translations'): string | null {
  const provider = buildProviderFor(platform);
  const base = provider?.baseUrl?.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/audio/${kind}`;
}

/** The request body shapes the catalog knows how to speak. */
export type TranscriptionShape = 'multipart' | 'base64-json';

/** Narrow a stored shape string to a known shape (defaults to multipart). */
export function shapeOf(row: { shape?: string }): TranscriptionShape {
  return row.shape === 'base64-json' ? 'base64-json' : 'multipart';
}

/** Sentence-case the shape for an error message. */
function shapeLabel(shape: string): string {
  return shape === 'base64-json' ? 'base64 JSON' : shape;
}

async function callTranscription(
  platform: string,
  apiKey: string,
  row: TranscriptionModelRow,
  kind: 'transcriptions' | 'translations',
  fields: Array<[string, MultipartValue]>,
  file: File,
  shape: TranscriptionShape = 'multipart',
): Promise<{ status: number; body: string }> {
  const url = resolveAudioEndpoint(platform, kind);
  if (!url) {
    throw new TranscriptionError(
      `no audio endpoint configured for platform '${platform}' — set its base URL or disable this catalog row`,
      500,
    );
  }

  // Never trust the client's model value on the wire; the catalog row is
  // authoritative.
  const stripped = STRIPPED_FIELDS[platform] ?? {};
  const passthrough = fields.filter(([key]) => stripped[key] !== true);
  const bytes = await file.arrayBuffer();

  let init: RequestInit;
  if (shape === 'base64-json') {
    // Some providers take the audio inline as base64 JSON instead of
    // multipart (zenmux 415s on multipart). One shape per catalog row.
    const body: Record<string, unknown> = {
      model: row.model_id,
      input_audio: {
        data: Buffer.from(bytes).toString('base64'),
        format: file.name.includes('.') ? file.name.split('.').pop() : 'wav',
      },
    };
    for (const [key, value] of passthrough) {
      if (typeof value === 'string') body[key] = value;
    }
    init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };
  } else {
    const form = new FormData();
    form.append('model', row.model_id);
    for (const [key, value] of passthrough) form.append(key, value);
    form.append('file', new Blob([bytes], { type: file.type || 'application/octet-stream' }), file.name);
    init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };
  }

  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (err) {
    // A transport failure is not an HTTP status; surface it as a 502 so the
    // failover loop treats it like any other provider error.
    throw new TranscriptionError(
      `${shapeLabel(shape)} request to ${new URL(url).host} failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
  const text = await r.text();
  if (!r.ok) {
    throw new TranscriptionError(`upstream ${r.status}: ${text.slice(0, 200)}`, r.status);
  }
  return { status: r.status, body: text };
}

function logTranscriptionRequest(
  row: TranscriptionModelRow,
  status: 'success' | 'error',
  tokens: { inputTokens: number; outputTokens: number; audioSeconds: number | null },
  latencyMs: number,
  error: string | null,
  keyId: number | null = null,
): void {
  try {
    // key_id is threaded through from the failover loop so audio spend is
    // attributable per key, the same way chat requests are. It was a
    // hardcoded NULL, which made per-key audio cost invisible.
    const safeError = error === null ? null : sanitizeProviderErrorMessage(error).slice(0, 300);
    getDb().prepare(`
      INSERT INTO requests
        (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, audio_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transcription', ?)
    `).run(row.platform, row.model_id, keyId, status, tokens.inputTokens, tokens.outputTokens, latencyMs, safeError, tokens.audioSeconds);
  } catch (e) {
    console.error('Failed to log transcription request:', e);
  }
}

/** Extract the provider-reported audio duration + token usage from a
 *  successful upstream body, best-effort. */
function parseUsage(body: string): { inputTokens: number; outputTokens: number; audioSeconds: number | null } {
  try {
    const j = JSON.parse(body) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_audio_seconds?: number };
      duration?: number;
    };
    return {
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      audioSeconds: j.usage?.prompt_audio_seconds ?? (typeof j.duration === 'number' ? j.duration : null),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, audioSeconds: null };
  }
}

/** Run a transcription/translation request through the family's provider
 *  chain, failing over within the family on any provider error. Throws
 *  TranscriptionError when the chain is dry. */
export async function runTranscription(request: TranscriptionCall): Promise<TranscriptionResult> {
  const { kind, model, fields, file, clientModelAllowlist } = request;
  const family = resolveFamily(model);
  if (!family) {
    throw new TranscriptionError(`unknown transcription model: '${model}'`, 400);
  }

  const chain = (getDb().prepare(
    'SELECT * FROM transcription_models WHERE family = ? AND enabled = 1 ORDER BY priority',
  ).all(family) as TranscriptionModelRow[]);
  if (chain.length === 0) {
    throw new TranscriptionError(`No enabled providers for transcription family '${family}'.`, 503);
  }

  // Translations gate: only rows explicitly flagged supports_translations.
  // Checked before the allowlist filter so the gate message is always the
  // model's own limitation, not the key's scope.
  if (kind === 'translations' && !chain.some(r => r.supports_translations === 1)) {
    throw new TranscriptionError('model does not support translation', 400);
  }
  const dispatchChain = kind === 'translations'
    ? chain.filter(r => r.supports_translations === 1)
    : chain;

  // Allowlist enforcement — audio mirrors the chat proxy, not embeddings.
  // On empty-after-filter, (b) fires unconditionally: the key can't reach
  // ANY provider of this family, whichever phrasing the caller expected.
  // (a) fires only when survivors exist but the explicitly requested
  // (non-'auto') resolved row isn't among them — e.g. a family whose other
  // providers are in scope while the pinned one isn't.
  let effectiveChain = dispatchChain;
  if (clientModelAllowlist && clientModelAllowlist.length > 0) {
    effectiveChain = dispatchChain.filter(r => isModelAllowed(clientModelAllowlist, r.platform, r.model_id));
    if (effectiveChain.length === 0) {
      throw new TranscriptionError('no transcription models allowed for this client key', 403);
    }
    if (model !== '' && model !== 'auto') {
      const requested = resolveTranscriptionModel(model);
      if (requested && !isModelAllowed(clientModelAllowlist, requested.platform, requested.model_id)) {
        throw new TranscriptionError('transcription model not allowed for this client key', 403);
      }
    }
  }

  let lastError: TranscriptionError | null = null;
  for (const row of effectiveChain) {
    const keys = getPlatformKeys(row.platform);
    if (keys.length === 0) {
      // Distinguish "no key" from "no endpoint" in the final error: an
      // operator who forgot the key needs a different action than one whose
      // provider has no audio route.
      lastError = resolveAudioEndpoint(row.platform, kind) === null
        ? new TranscriptionError(`no audio endpoint for platform '${row.platform}'`, 500)
        : new TranscriptionError(`no usable key for platform '${row.platform}'`, 503);
      continue;
    }
    for (const { id: keyId, key } of keys) {
      const started = Date.now();
      try {
        const out = await callTranscription(row.platform, key, row, kind, fields, file, shapeOf(row));
        const usage = parseUsage(out.body);
        logTranscriptionRequest(row, 'success', usage, Date.now() - started, null, keyId);
        return { status: out.status, body: out.body, row, actualSeconds: usage.audioSeconds };
      } catch (err: unknown) {
        const e = err instanceof TranscriptionError
          ? err
          : new TranscriptionError(err instanceof Error ? err.message : String(err), 502);
        logTranscriptionRequest(row, 'error', { inputTokens: 0, outputTokens: 0, audioSeconds: null }, Date.now() - started, e.message, keyId);
        lastError = e;
        // try the next key for this provider
      }
    }
  }

  throw new TranscriptionError(
    `All providers for transcription family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
  );
}
