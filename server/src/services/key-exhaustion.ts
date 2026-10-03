/**
 * Per-key exhaustion tracking.
 *
 * When a key fails 3 consecutive retries it is marked "exhausted" for the
 * current model. Keys are cycled in exhaustion order (earliest first) so the
 * key that has had the longest time to recover gets tried first. A single
 * successful request clears the exhaustion; the key can be exhausted again
 * later (re-entering at the end of the queue).
 *
 * State is in-memory for speed and persists across restarts via the existing
 * rate_limit_cooldowns table (any non-expired cooldown implies exhaustion).
 * On startup we rebuild the in-memory Map from that table.
 */

import { getDb } from '../db/index.js';

// compositeKey (keyId:modelId) → { exhaustedAt, provider, modelId, resetAtMs?, modelDbId? }
const exhaustionMap = new Map<string, { exhaustedAt: number; provider: string; modelId: string; resetAtMs?: number; modelDbId?: number }>();

/** Rebuild the in-memory exhaustion map from persistent cooldowns on startup. */
export function rebuildExhaustionFromDB(): void {
  exhaustionMap.clear();
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT key_id, platform, model_id, expires_at_ms
    FROM rate_limit_cooldowns
    WHERE expires_at_ms > ?
  `).all(now) as Array<{ key_id: number; platform: string; model_id: string; expires_at_ms: number }>;

  for (const row of rows) {
    // Preserve the actual expiry as the exhausted-at timestamp — the recovery-
    // path ordering (router.ts:587-599) sorts by exhaustedAt earliest-first,
    // which is exactly what the persisted expiry encodes.
    exhaustionMap.set(`${row.key_id}:${row.model_id}`, {
      exhaustedAt: row.expires_at_ms,
      provider: row.platform,
      modelId: row.model_id,
    });
  }
}

/** Mark a key as exhausted for a specific provider+model. `quota` carries the
 *  moment the key's plan window resumes (parsed from the provider's own error)
 *  plus the model row it belongs to, so the recovery loop can retry the
 *  soonest-resetting key at the right time instead of polling. */
export function markExhausted(
  keyId: number,
  provider: string,
  modelId: string,
  quota?: { resetAtMs?: number; modelDbId?: number },
): void {
  exhaustionMap.set(`${keyId}:${modelId}`, {
    exhaustedAt: Date.now(),
    provider,
    modelId,
    resetAtMs: quota?.resetAtMs,
    modelDbId: quota?.modelDbId,
  });
}

export function clearExhausted(keyId: number, modelId: string): void {
  exhaustionMap.delete(`${keyId}:${modelId}`);
  // Also remove any persisted cooldown for this key+model so a restart
  // doesn't resurrect a stale exhaustion.
  const db = getDb();
  db.prepare('DELETE FROM rate_limit_cooldowns WHERE key_id = ? AND model_id = ?').run(keyId, modelId);
}

/** Drop every exhaustion entry for a key across all models. Called when the
 *  key is deleted so stale entries don't linger in the in-memory map. */
export function clearExhaustedForKey(keyId: number): void {
  const prefix = `${keyId}:`;
  for (const compositeKey of exhaustionMap.keys()) {
    if (compositeKey.startsWith(prefix)) exhaustionMap.delete(compositeKey);
  }
}

/** Check whether a key is currently marked exhausted. */
export function isExhausted(keyId: number, modelId: string): boolean {
  return exhaustionMap.has(`${keyId}:${modelId}`);
}
/**
 * Get all exhausted keys for a given provider, sorted by exhaustion time
 * ascending (earliest exhausted first). Excludes keys that have naturally
 * expired from the in-memory map.
 */
export function getExhaustedKeysForProvider(provider: string): Array<{ keyId: number; exhaustedAt: number; modelId: string }> {
  const result: Array<{ keyId: number; exhaustedAt: number; modelId: string }> = [];
  for (const [compositeKey, info] of exhaustionMap) {
    if (info.provider === provider) {
      const keyId = Number(compositeKey.split(':')[0]);
      result.push({ keyId, exhaustedAt: info.exhaustedAt, modelId: info.modelId });
    }
  }
  result.sort((a, b) => a.exhaustedAt - b.exhaustedAt);
  return result;
}
/**
 * Same as getExhaustedKeysForProvider but scoped to a specific model.
 */
export function getExhaustedKeysForModel(provider: string, modelId: string): Array<{ keyId: number; exhaustedAt: number; resetAtMs?: number }> {
  const result: Array<{ keyId: number; exhaustedAt: number; resetAtMs?: number }> = [];
  for (const [compositeKey, info] of exhaustionMap) {
    if (info.provider === provider && info.modelId === modelId) {
      const keyId = Number(compositeKey.split(':')[0]);
      result.push({ keyId, exhaustedAt: info.exhaustedAt, resetAtMs: info.resetAtMs });
    }
  }
  result.sort((a, b) => a.exhaustedAt - b.exhaustedAt);
  return result;
}

/** True when an exhausted key in scope has NO stated reset time — its window
 *  is unknown, so the recovery loop must not sleep past the normal poll
 *  interval waiting for a DIFFERENT key's far-away stated reset. `modelDbId`
 *  scopes the scan the same way getSoonestResetAtMs does. */
export function hasExhaustedKeyWithoutReset(modelDbId?: number): boolean {
  for (const info of exhaustionMap.values()) {
    if (info.resetAtMs != null) continue;
    // Entries marked without a model row (the circuit-breaker path) carry no
    // reset either, and can belong to whatever scope is asking — count them.
    if (modelDbId !== undefined && info.modelDbId !== undefined && info.modelDbId !== modelDbId) continue;
    return true;
  }
  return false;
}

/** The soonest moment any exhausted key says its quota window resumes.
 *  `modelDbId` scopes the scan to one model (a pinned request waits for its
 *  own model's keys); omit it to scan every exhausted key. Returns null when
 *  no exhausted key reported a reset time. */
export function getSoonestResetAtMs(modelDbId?: number): number | null {
  let soonest: number | null = null;
  for (const info of exhaustionMap.values()) {
    if (info.resetAtMs == null) continue;
    if (modelDbId !== undefined && info.modelDbId !== modelDbId) continue;
    if (soonest === null || info.resetAtMs < soonest) soonest = info.resetAtMs;
  }
  return soonest;
}
