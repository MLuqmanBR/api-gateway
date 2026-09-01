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

function getPlatformKeys(platform: string): string[] {
  const rows = getDb().prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY id",
  ).all(platform) as { encrypted_key: string; iv: string; auth_tag: string }[];
  const keys: string[] = [];
  for (const row of rows) {
    try {
      keys.push(decrypt(row.encrypted_key, row.iv, row.auth_tag));
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

/** Parse a raw multipart body via the bundled-undici Request.formData(). The
 *  first File-valued entry is the file; `model`/`stream` are read from string
 *  entries and returned separately (the service rewrites model from the
 *  catalog row and never forwards stream). */
export async function parseAudioRequest(contentType: string, body: Buffer): Promise<{
  fields: Array<[string, MultipartValue]>;
  file: File | null;
  model: string;
  stream: boolean;
}> {
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

/** Fields mistral rejects even though groq accepts them. */
const MISTRAL_STRIPPED: Record<string, true> = { prompt: true, response_format: true };

async function callTranscription(
  platform: string,
  apiKey: string,
  row: TranscriptionModelRow,
  kind: 'transcriptions' | 'translations',
  fields: Array<[string, MultipartValue]>,
  file: File,
): Promise<{ status: number; body: string }> {
  let url: string;
  switch (platform) {
    case 'groq':
      url = `https://api.groq.com/openai/v1/audio/${kind}`;
      break;
    case 'mistral':
      // Mistral exposes transcriptions only — the translations gate (route
      // step) rejects mistral translation requests before we get here.
      url = 'https://api.mistral.ai/v1/audio/transcriptions';
      break;
    default:
      throw new TranscriptionError(`no transcription adapter for platform '${platform}'`, 500);
  }

  // Rebuild the outbound body from the parsed entries — never trust the
  // client's model value on the wire; the catalog row is authoritative.
  const form = new FormData();
  form.append('model', row.model_id);
  for (const [key, value] of fields) {
    if (platform === 'mistral' && MISTRAL_STRIPPED[key] === true) continue;
    form.append(key, value);
  }
  form.append(
    'file',
    new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' }),
    file.name,
  );

  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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
): void {
  try {
    getDb().prepare(`
      INSERT INTO requests
        (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, audio_seconds)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'transcription', ?)
    `).run(row.platform, row.model_id, status, tokens.inputTokens, tokens.outputTokens, latencyMs, error, tokens.audioSeconds);
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
    throw new TranscriptionError(
      `unknown transcription model '${model}'. Use 'auto', a family name, or a provider model id.`, 400,
    );
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
    throw new TranscriptionError(`model does not support translation ('${family}')`, 400);
  }
  const dispatchChain = kind === 'translations'
    ? chain.filter(r => r.supports_translations === 1)
    : chain;

  // Allowlist enforcement — audio mirrors the chat proxy, not embeddings.
  // The filter runs against the dispatchable rows; the two 403s are distinct:
  // (a) the requested family/model itself is out of scope, (b) the family is
  // fine but every provider row in it is filtered out.
  let effectiveChain = dispatchChain;
  if (clientModelAllowlist && clientModelAllowlist.length > 0) {
    effectiveChain = dispatchChain.filter(r => isModelAllowed(clientModelAllowlist, r.platform, r.model_id));
    if (effectiveChain.length === 0) {
      const requested = resolveTranscriptionModel(model);
      if (requested && !isModelAllowed(clientModelAllowlist, requested.platform, requested.model_id)) {
        throw new TranscriptionError(`transcription model '${requested.platform}/${requested.model_id}' not allowed for this client key`, 403);
      }
      throw new TranscriptionError('no transcription models allowed for this client key', 403);
    }
  }

  let lastError: TranscriptionError | null = null;
  for (const row of effectiveChain) {
    const keys = getPlatformKeys(row.platform);
    if (keys.length === 0) continue; // no usable key for this provider — try the next one
    for (const key of keys) {
      const started = Date.now();
      try {
        const out = await callTranscription(row.platform, key, row, kind, fields, file);
        const usage = parseUsage(out.body);
        logTranscriptionRequest(row, 'success', usage, Date.now() - started, null);
        return { status: out.status, body: out.body, row, actualSeconds: usage.audioSeconds };
      } catch (err: unknown) {
        const e = err instanceof TranscriptionError
          ? err
          : new TranscriptionError(err instanceof Error ? err.message : String(err), 502);
        logTranscriptionRequest(row, 'error', { inputTokens: 0, outputTokens: 0, audioSeconds: null }, Date.now() - started, e.message.slice(0, 300));
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
