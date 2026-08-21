/**
 * F5: Response caching — exact-match, temp-0, per-request cache-control.
 *
 * Two-tier L1 (in-memory LRU, 2048 entries) / L2 (SQLite response_cache table)
 * per OmniRoute's pattern. The cache key is a SHA-256 hash of the full request
 * signature: model + messages + tools + tool_choice + temperature + top_p +
 * penalties + reasoning_effort + thinking.budget + max_tokens.
 *
 * Only temperature === 0 requests are cacheable (deterministic). Bypass:
 * `cache:{no-cache:true}` in the request body OR `X-API-Gateway-No-Cache`
 * header. TTL default 24h (settings key `cache_ttl_seconds`).
 *
 * Streaming hit = synthesize SSE chunks from the cached JSON (OmniRoute's
 * "synthetic stream" approach).
 *
 * Attribution: concept from BerriAI/litellm (MIT, caching/) and
 * diegosouzapw/OmniRoute (MIT, src/lib/semanticCache.ts).
 */

import { createHash } from 'crypto';
import { getDb, getSetting } from '../db/index.js';
import { parseIntSetting } from '../lib/settings-parse.js';
import type { DatabasePort } from '../db/types.js';

const L1_MAX = 2048;
// L17: a synchronous `hits+1` UPDATE on every L1 hit put a write on the hot
// path of every cache serve. Batch the counter instead — an entry accrues
// pending hits in memory and flushes them to L2 in one UPDATE every
// HIT_FLUSH_EVERY hits (or when the entry leaves the cache). Final counts
// are identical; only the write cadence changes.
const HIT_FLUSH_EVERY = 16;
type L1Entry = { response: string; createdAtMs: number; pendingHits?: number };
const lru = new Map<string, L1Entry>();

/** LRU get: move to end (most-recently-used). */
function lruGet(key: string): L1Entry | undefined {
  const entry = lru.get(key);
  if (entry) {
    lru.delete(key);
    lru.set(key, entry); // re-insert at end
  }
  return entry;
}

/** LRU set: evict least-recently-used if over capacity. */
function lruSet(key: string, entry: L1Entry) {
  lru.set(key, entry);
  if (lru.size > L1_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
}

/** Clear the L1 cache (for tests / admin purge). */
function clearL1() { lru.clear(); }

/** Flush an L1 entry's batched hit count into L2 (best-effort — the L2 row
 *  may already be purged; stats must never break serving). */
function flushPendingHits(key: string, entry: L1Entry): void {
  const n = entry.pendingHits ?? 0;
  if (n <= 0) return;
  try { getDb().prepare('UPDATE response_cache SET hits = hits + ? WHERE key = ?').run(n, key); } catch { /* L2 may be purged */ }
  entry.pendingHits = 0;
}

/** Compute TTL in seconds from settings (default 86400 = 24h).
 *  M20: NaN-safe — a corrupt stored value previously caused parseInt to
 *  return NaN, making every TTL comparison false and instantly expiring
 *  every entry. */
function getTtlSeconds(): number {
  return parseIntSetting('cache_ttl_seconds', 86400);
}

/** Is the cache enabled? Default true (opt-out). */
export function isCacheEnabled(): boolean {
  const raw = getSetting('cache_enabled');
  return raw !== 'false'; // default true
}

/** Is the request cacheable? Only temperature === 0 (deterministic). */
export function isCacheableTemp(temperature: unknown, topP: unknown): boolean {
  // Only explicit temperature === 0 is cacheable. Undefined temperature
  // defaults to 1.0 in the OpenAI API, which is NOT deterministic.
  return temperature === 0 && (topP === undefined || topP === 1);
}

/** Check if the request bypasses the cache (no-cache directive). */
export function isCacheBypassed(cacheDirective: unknown, noCacheHeader: string | undefined): boolean {
  if (noCacheHeader) return true;
  if (cacheDirective && typeof cacheDirective === 'object') {
    const c = cacheDirective as { no_cache?: boolean; 'no-cache'?: boolean; no_store?: boolean; ttl?: number };
    if (c.no_cache || c['no-cache'] || c.no_store) return true;
  }
  return false;
}

/** Compute the cache key from the full request signature. */
export function computeCacheKey(params: {
  model: string;
  messages: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  frequency_penalty?: unknown;
  presence_penalty?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
}): string {
  // Build a stable JSON string of all fields that affect the response.
  // Exclude non-deterministic fields like stream, seed, and user.
  const signature = {
    model: params.model,
    messages: params.messages,
    tools: params.tools ?? null,
    tool_choice: params.tool_choice ?? null,
    temperature: params.temperature ?? null,
    top_p: params.top_p ?? null,
    max_tokens: params.max_tokens ?? null,
    frequency_penalty: params.frequency_penalty ?? null,
    presence_penalty: params.presence_penalty ?? null,
    reasoning_effort: params.reasoning_effort ?? null,
    thinking: params.thinking ?? null,
  };
  const json = JSON.stringify(signature);
  return createHash('sha256').update(json).digest('hex');
}

/** Get a cached response. Returns the raw JSON string or null on miss/expiry. */
export function getCachedResponse(key: string): string | null {
  const ttlMs = getTtlSeconds() * 1000;
  const now = Date.now();

  // L1 check
  const l1 = lruGet(key);
  if (l1) {
    if (now - l1.createdAtMs < ttlMs) {
      // Count the hit (L2 rows back the stats UI) but batched — see the L17
      // note at HIT_FLUSH_EVERY.
      l1.pendingHits = (l1.pendingHits ?? 0) + 1;
      if (l1.pendingHits >= HIT_FLUSH_EVERY) flushPendingHits(key, l1);
      return l1.response;
    }
    flushPendingHits(key, l1); // expired — flush residue before eviction
    lru.delete(key); // expired
  }

  // L2 check (SQLite)
  const db = getDb();
  const row = db.prepare('SELECT response_json, created_at_ms FROM response_cache WHERE key = ?').get(key) as
    { response_json: string; created_at_ms: number } | undefined;
  if (row) {
    if (now - row.created_at_ms < ttlMs) {
      // Promote to L1
      lruSet(key, { response: row.response_json, createdAtMs: row.created_at_ms });
      // Increment hits (fire-and-forget, non-blocking)
      db.prepare('UPDATE response_cache SET hits = hits + 1 WHERE key = ?').run(key);
      return row.response_json;
    }
    // Expired — delete from L2
    db.prepare('DELETE FROM response_cache WHERE key = ?').run(key);
  }

  return null;
}

/** Store a response in the cache (both L1 and L2). */
export function setCachedResponse(key: string, responseJson: string): void {
  const now = Date.now();
  const prev = lru.get(key);
  if (prev) flushPendingHits(key, prev); // overwrite — flush old entry's residue
  lruSet(key, { response: responseJson, createdAtMs: now });

  const db = getDb();
  db.prepare(`
    INSERT INTO response_cache (key, response_json, created_at_ms, hits, tokens_saved)
    VALUES (?, ?, ?, 0, 0)
    ON CONFLICT(key) DO UPDATE SET response_json = excluded.response_json, created_at_ms = excluded.created_at_ms
  `).run(key, responseJson, now);
}

/** Purge all cached responses (admin action). Returns the number of entries removed. */
export function purgeCache(): number {
  lru.clear();
  const db = getDb();
  const result = db.prepare('DELETE FROM response_cache').run();
  return result.changes;
}

/** Get cache stats for the admin UI. */
export function getCacheStats(): { entries: number; hits: number; l1Size: number } {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as n, COALESCE(SUM(hits), 0) as total_hits FROM response_cache').get() as
    { n: number; total_hits: number };
  return { entries: row.n, hits: row.total_hits, l1Size: lru.size };
}

/**
 * Synthesize an SSE stream from a cached non-streaming JSON response.
 * Emits the same chunk sequence a real streaming response would produce:
 * a first chunk with the role, then content delta chunks, then [DONE].
 *
 * M04: returns null when the cached response carries tool_calls — they
 * cannot be faithfully replayed as SSE (argument chunking, parallel-call
 * indices, per-call deltas), so the caller must fall back to non-stream
 * replay instead of silently dropping the calls.
 * M04: the cached `created` timestamp is echoed on every chunk.
 */
export function synthesizeSSE(cachedJson: string): string | null {
  const response = JSON.parse(cachedJson) as {
    id: string;
    model: string;
    created?: number;
    choices: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string; type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string;
    }>;
  };

  // M04: refuse to replay tool-bearing completions as SSE. Content deltas
  // and tool-call argument chunks are interleaved by a real provider stream;
  // replaying text-only while claiming finish_reason 'tool_calls' loses all
  // tool data — worse than falling back to a non-streaming JSON response.
  const message = response.choices?.[0]?.message;
  if (message?.tool_calls && message.tool_calls.length > 0) return null;

  const id = response.id;
  const model = response.model;
  const created = response.created ?? Math.floor(Date.now() / 1000);
  const content = message?.content ?? '';
  const finishReason = response.choices?.[0]?.finish_reason ?? 'stop';

  const chunks: string[] = [];

  // First chunk: role
  chunks.push(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`);

  // Content chunks (split by ~20 char segments for a realistic stream feel)
  const segmentSize = 20;
  for (let i = 0; i < content.length; i += segmentSize) {
    const segment = content.slice(i, i + segmentSize);
    chunks.push(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: segment }, finish_reason: null }],
    })}\n\n`);
  }

  // Final chunk: finish_reason
  chunks.push(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`);

  chunks.push('data: [DONE]\n\n');

  return chunks.join('');
}
