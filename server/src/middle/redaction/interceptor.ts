/**
 * AI interceptor stage — Rows B2-4 (outbound) + B2-4b (inbound).
 *
 * Stage-2 detection of NOT-yet-known sensitive values, using a user-assigned
 * interceptor model. The interceptor scans text whose known secrets have
 * already been replaced by Stage-1 placeholders — so known secrets never
 * reach even the interceptor model. New secrets found by the interceptor are
 * added to the store and re-redacted with standard placeholders.
 *
 * Failure floor (decided by user, not revisited): any throw/timeout/non-JSON/
 * schema-mismatch → log one line, increment a counter, continue with Stage-1
 * output. Never retried within a request, never blocks.
 */

import crypto from 'crypto';
import type { ChatMessage } from '@api-gateway/shared/types.js';
import { getDb, getSetting } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { buildProviderFor } from '../../providers/index.js';
import { RedactionSession } from './session.js';
import { addSecret, getActiveSecretsForRedaction } from './store.js';

// --- Scanned-LRU cache (module-level, per-boot) ---
// Agentic clients resend the whole history every turn. With this cache, only
// the NEW tail messages get scanned — identical history messages are skipped.

const scannedCache = new Map<string, true>();
const SCANNED_CACHE_MAX = 4096;

function textHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isScanned(text: string): boolean {
  return scannedCache.has(textHash(text));
}

function markScanned(text: string): void {
  const hash = textHash(text);
  if (scannedCache.size >= SCANNED_CACHE_MAX) {
    // Evict oldest (first-inserted key — Map preserves insertion order)
    const oldest = scannedCache.keys().next().value;
    if (oldest !== undefined) scannedCache.delete(oldest);
  }
  scannedCache.set(hash, true);
}

// --- Interceptor prompt (fixed, versioned) ---

const INTERCEPTOR_PROMPT_VERSION = 1;

function buildSystemPrompt(detectionTargets: string[]): string {
  return [
    'You are a security assistant. Identify sensitive information in the text below.',
    'Return ONLY a JSON array of objects with "exact" (the verbatim substring from the text)',
    `and "kind" (one of: ${detectionTargets.join(', ')}).`,
    'No commentary, no rewriting. If no sensitive content, return [].',
  ].join(' ');
}

// --- Failure counter ---

let interceptorFailures = 0;

export function getInterceptorFailures(): number {
  return interceptorFailures;
}

/** Reset the failure counter — used by tests. */
export function _resetInterceptorStateForTesting(): void {
  interceptorFailures = 0;
  scannedCache.clear();
}

// --- Type for interceptor model lookup ---

interface ModelRow {
  platform: string;
  model_id: string;
}

interface KeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

interface InterceptorSpan {
  exact: string;
  kind: string;
}

// --- Core dispatch ---

async function dispatchInterceptor(
  text: string,
  modelDbId: number,
  timeoutMs: number,
  detectionTargets: string[],
): Promise<InterceptorSpan[]> {
  const db = getDb();
  const modelRow = db.prepare(
    'SELECT platform, model_id FROM models WHERE id = ? AND enabled = 1',
  ).get(modelDbId) as ModelRow | undefined;
  if (!modelRow) throw new Error(`Interceptor model ${modelDbId} not found or disabled`);

  const provider = buildProviderFor(modelRow.platform);
  if (!provider) throw new Error(`No provider for platform ${modelRow.platform}`);

  const keyRow = db.prepare(
    "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') LIMIT 1",
  ).get(modelRow.platform) as KeyRow | undefined;
  if (!keyRow) throw new Error(`No healthy key for platform ${modelRow.platform}`);

  const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(detectionTargets) },
    { role: 'user', content: text },
  ];

  const response = await provider.chatCompletion(apiKey, messages, modelRow.model_id, {
    temperature: 0,
    max_tokens: 1024,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return [];

  // Parse + validate the JSON array. Never trust model output shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Interceptor returned non-JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Interceptor returned non-array');
  return parsed.filter(
    (item): item is InterceptorSpan =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).exact === 'string' &&
      typeof (item as Record<string, unknown>).kind === 'string',
  );
}

/** Find all verbatim occurrences of `exact` in `text` via indexOf scanning.
 * Values not found verbatim are DISCARDED — the model can only nominate
 * substrings that actually exist in the text. */
function extractNewSecrets(
  text: string,
  spans: InterceptorSpan[],
): Array<{ value: string; kind: string }> {
  const found: Array<{ value: string; kind: string }> = [];
  for (const span of spans) {
    if (text.indexOf(span.exact) !== -1) {
      found.push({ value: span.exact, kind: span.kind });
    }
  }
  return found;
}

/** Extract all text fields from a message for scanning. */
function messageTexts(msg: ChatMessage): string[] {
  const texts: string[] = [];
  if (typeof msg.content === 'string') texts.push(msg.content);
  else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block === 'string') texts.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
  }
  if (typeof msg.reasoning_content === 'string') texts.push(msg.reasoning_content);
  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) texts.push(tc.function.arguments);
  }
  return texts;
}

// --- Settings helpers ---

function getInterceptorModelId(): number | null {
  const raw = getSetting('middle_interceptor_model');
  if (!raw) return null;
  const id = Number(raw);
  return Number.isNaN(id) || id <= 0 ? null : id;
}

function getInterceptorTimeoutMs(): number {
  return Number(getSetting('middle_interceptor_timeout_ms') ?? '4000') || 4000;
}

function getDetectionTargets(): string[] {
  try {
    const raw = getSetting('middle_detection_targets');
    if (!raw) return ['api_key', 'email', 'phone', 'person', 'address'];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* fall through to default */ }
  return ['api_key', 'email', 'phone', 'person', 'address'];
}

function isInboundEnabled(): boolean {
  return getSetting('middle_interceptor_inbound_enabled') === '1';
}

// --- Public API: outbound interceptor (Row B2-4) ---

/** Scan Stage-1-redacted messages for new secrets via the interceptor model.
 * Adds found secrets to the store and re-redacts. Returns the re-redacted
 * messages (or the input unchanged if no model / no new secrets / failure). */
export async function interceptOutbound(
  messages: ChatMessage[],
  session: RedactionSession,
): Promise<{ messages: ChatMessage[]; newSecretsFound: boolean }> {
  const modelId = getInterceptorModelId();
  if (modelId === null) return { messages, newSecretsFound: false };

  const timeoutMs = getInterceptorTimeoutMs();
  const detectionTargets = getDetectionTargets();
  let newSecretsFound = false;

  for (const msg of messages) {
    for (const text of messageTexts(msg)) {
      if (isScanned(text)) continue;
      markScanned(text);

      try {
        const spans = await dispatchInterceptor(text, modelId, timeoutMs, detectionTargets);
        const newSecrets = extractNewSecrets(text, spans);
        for (const { value, kind } of newSecrets) {
          addSecret(value, kind, 'ai');
          newSecretsFound = true;
        }
      } catch (err) {
        // Failure floor: log, increment counter, continue. Never block.
        interceptorFailures++;
        console.warn('[Middle] Interceptor failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  if (newSecretsFound) {
    // Re-redact with the updated store (now includes interceptor-found secrets).
    session.rebuildSecrets();
    return { messages: session.redactOutbound(messages), newSecretsFound: true };
  }
  return { messages, newSecretsFound: false };
}

// --- Public API: inbound interceptor (Row B2-4b — per-direction, non-stream) ---

/** Scan a complete (un-redacted) response text for new secrets the model
 * emitted. Adds found secrets to the store and re-redacts the text so the
 * client sees placeholders for model-emitted new secrets.
 *
 * ONLY for non-streaming responses (R1/R3). Streaming responses (R2/R4) skip
 * inbound AI detection — detecting a secret split across SSE chunks would
 * require buffering the whole stream, which kills streaming. A new secret
 * the model emits in a stream reaches the client THIS turn but is caught by
 * outbound detection on the next agentic turn. (D2 per-direction decision.) */
export async function interceptInbound(
  text: string,
  _session: RedactionSession,
): Promise<{ text: string; newSecretsFound: boolean }> {
  if (!isInboundEnabled()) return { text, newSecretsFound: false };
  const modelId = getInterceptorModelId();
  if (modelId === null) return { text, newSecretsFound: false };

  const timeoutMs = getInterceptorTimeoutMs();
  const detectionTargets = getDetectionTargets();

  if (isScanned(text)) return { text, newSecretsFound: false };
  markScanned(text);

  try {
    const spans = await dispatchInterceptor(text, modelId, timeoutMs, detectionTargets);
    const newSecrets = extractNewSecrets(text, spans);
    for (const { value, kind } of newSecrets) {
      addSecret(value, kind, 'ai');
    }
    if (newSecrets.length > 0) {
      // Re-redact ONLY the new secrets — outbound secrets were already
      // un-redacted (R1/R3) and should reach the client as real values.
      // Creating a session with all active secrets would re-redact the
      // outbound ones too, hiding the client's own secrets behind
      // placeholders they can't un-redact.
      const newValues = new Set(newSecrets.map(s => s.value));
      const newOnly = getActiveSecretsForRedaction().filter(s => newValues.has(s.value));
      const inboundSession = new RedactionSession(newOnly);
      const redacted = inboundSession.redactOutbound([{ role: 'assistant', content: text }]);
      return { text: redacted[0].content as string, newSecretsFound: true };
    }
  } catch (err) {
    interceptorFailures++;
    console.warn('[Middle] Inbound interceptor failed:', err instanceof Error ? err.message : String(err));
  }
  return { text, newSecretsFound: false };
}

// Exported for testing / dashboard stats
export { INTERCEPTOR_PROMPT_VERSION };
