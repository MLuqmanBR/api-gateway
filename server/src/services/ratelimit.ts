// Sliding window rate limit tracker with SQLite persistence.

import { getDb } from '../db/index.js';
import { markKeyHealthyFromRequest } from './health.js';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map<string, Window>();
type RateLimitDb = ReturnType<typeof getDb>;
type UsageKind = 'request' | 'tokens';

// ── Optimistic in-flight reservations (#42, check-then-act race) ──
// routeRequest is synchronous, but the persisted counter is only written by
// recordRequest AFTER the awaited upstream dispatch. So two concurrent requests
// for the same (platform,model,key) can both pass the pre-check before either
// records, briefly overshooting rpm/tpm and the provider-minute cap. To close
// that window, routeRequest reserves a provisional entry here at selection time
// (synchronously, so the next routeRequest sees it); the gating counters below
// add these provisional reservations on top of the persisted/memory base. The
// reservation is released on every route exit — success (recordRequest has by
// then written the persisted row that supersedes it) or abandon/error (rolled
// back) — via the route's release() closure, so persisted counters stay the
// source of truth.
interface Reservation {
  platform: string;
  modelId: string;
  keyId: number;
  ts: number;
  tokens: number;
}
const reservations = new Map<number, Reservation>();
let reservationSeq = 0;

// M26: live-leaf buckets indexed by "platform:keyId". provisionalSummary was
// O(all in-flight reservations) per rate-limit check and runs from
// requestCount/tokenCount (per model-row) plus both provider-minute counters
// — under burst routing that was O(chain × keys × in-flight) per request.
// Buckets hold only live, unexpired leaves; expiry and release remove leaves
// so scans stay bounded by that pair's in-flight count, not the global map.
interface CounterLeaf { id: number; ts: number; tokens: number; modelId: string }
const pairLeaves = new Map<string, CounterLeaf[]>();

function getPairLeaves(pairKey: string): CounterLeaf[] {
  let l = pairLeaves.get(pairKey);
  if (!l) {
    l = [];
    pairLeaves.set(pairKey, l);
  }
  return l;
}

function removeLeaf(leaves: CounterLeaf[], id: number): number {
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i].id === id) {
      const tokens = leaves[i].tokens;
      leaves.splice(i, 1);
      return tokens;
    }
  }
  return 0;
}

/** Reserve a provisional request + token slot for a just-selected route.
 *  Returns an opaque handle to release exactly once via releaseReservation(). */
export function reserveRequest(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
): number {
  const id = ++reservationSeq;
  const tokens = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0;
  const ts = Date.now();
  reservations.set(id, { platform, modelId, keyId, ts, tokens });
  getPairLeaves(`${platform}:${keyId}`).push({ id, ts, tokens, modelId });
  return id;
}

/** Release a reservation. Idempotent — a missing id is a no-op. */
export function releaseReservation(id: number): void {
  const r = reservations.get(id);
  if (!r) return;
  reservations.delete(id);
  const leaves = pairLeaves.get(`${r.platform}:${r.keyId}`);
  if (leaves) removeLeaf(leaves, id);
}

/** Summarize provisional reservations for a platform+key, optionally
 *  filtered by modelId. Returns { count, tokens } in one pass over the
 *  pair's live leaves (bounded by that key's in-flight count). */
function provisionalSummary(
  platform: string,
  keyId: number,
  cutoff: number,
  modelId?: string,
): { count: number; tokens: number } {
  const pairKey = `${platform}:${keyId}`;
  const leaves = pairLeaves.get(pairKey);
  if (!leaves || leaves.length === 0) return { count: 0, tokens: 0 };
  let count = 0, tokens = 0;
  let writeTo = 0;
  for (let read = 0; read < leaves.length; read++) {
    const leaf = leaves[read];
    if (leaf.ts <= cutoff) continue; // expired — drop from bucket
    if (reservations.get(leaf.id) === undefined) continue; // released — drop
    if (modelId === undefined || leaf.modelId === modelId) {
      count++;
      tokens += leaf.tokens;
    }
    leaves[writeTo++] = leaf; // compact in place
  }
  leaves.length = writeTo;
  return { count, tokens };
}

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function withDb<T>(fn: (db: RateLimitDb) => T): T | undefined {
  try {
    return fn(getDb());
  } catch (err) {
    console.error('[RateLimit] DB write failed:', err);
    return undefined;
  }
}

function recordUsage(
  platform: string,
  modelId: string,
  keyId: number,
  kind: UsageKind,
  tokens: number,
  now: number,
) {
  withDb(db => {
    // L27: INSERT + prune DELETE are one unit — wrap them so a failure between
    // the two statements rolls back atomically (the WASM backend implements
    // transactions as savepoints, where partial application would stick).
    db.transaction(() => {
      db.prepare(`
        INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(platform, modelId, keyId, kind, tokens, now);
      db.prepare('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?').run(now - DAY);
    })();
  });
}

function countPersistedRequests(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function sumPersistedTokens(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'tokens'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function memoryRequestCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.timestamps = pruneTimestamps(w.timestamps, windowMs, now);
  return w.timestamps.length;
}

function memoryTokenCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
  return w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

function requestCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const provisional = provisionalSummary(platform, keyId, now - windowMs, modelId).count;
  const persisted = countPersistedRequests(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted + provisional;
  const type = windowMs === MINUTE ? 'rpm' : 'rpd';
  return memoryRequestCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now) + provisional;
}

function tokenCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const provisional = provisionalSummary(platform, keyId, now - windowMs, modelId).tokens;
  const persisted = sumPersistedTokens(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted + provisional;
  const type = windowMs === MINUTE ? 'tpm' : 'tpd';
  return memoryTokenCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now) + provisional;
}

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  // X1: per-MINUTE gate stays (naturally resets ~60s, no long bench).
  if (limits.rpm !== null) {
    if (requestCount(platform, modelId, keyId, MINUTE, now) >= limits.rpm) return false;
  }

  // X1: per-DAY gate removed — no long bench from rpd. Daily-exhausted keys
  // retry every ~90s until UTC midnight (user-accepted).

  return true;
}

export function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  // X1: per-MINUTE gate stays (naturally resets ~60s, no long bench).
  if (limits.tpm !== null) {
    const used = tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  // X1: per-DAY gate removed — no long bench from tpd.

  return true;
}

// X1: canUseProvider (per-DAY provider-wide gate) REMOVED — no long bench.
// The per-MINUTE provider-wide gate (canUseProviderMinute) STAYS.
// ── Provider-wide per-minute caps (#295) ──
// Some providers
// enforce ONE per-minute request (and/or per-minute token) quota across the
// WHOLE account, shared by every model — not per model. NVIDIA NIM is the
// case in point: a single 40 RPM budget is drawn from by glm-5.1, glm-5.2,
// minimax-m3, deepseek, nemotron, and every other nvidia model under one key.
// The per-(platform,model,key) rpm/tpm ledger in canMakeRequest/canUseTokens
// can't see that — each model row is accounted in isolation, so the gateway
// happily allows (models × rpm) requests/min against a key and then eats real
// upstream 429s. Without this provider-wide gate, a manually-added model row
// with rpm_limit=NULL (e.g. minimax-m3 before the backfill) slips through with
// zero pre-throttling while its sibling GLM rows self-throttle at 40 — exactly
// the asymmetry that surfaced as "glm-5.2 exhausts all keys, minimax-m3 works
// on the same key".
//
// Cap sources, in precedence order (mirroring the per-model ladder in
// router.ts): env var > built_in_provider_settings.<platform>.rpm_limit /
// tpm_limit > DEFAULT_PROVIDER_MINUTE_*_CAPS > null (uncapped).
const DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS: Record<string, number> = {
  nvidia: 40,
};
const DEFAULT_PROVIDER_MINUTE_TOKEN_CAPS: Record<string, number> = {};

/** Resolve the shared per-minute request cap for a provider account+key.
 *  Returns null (uncapped) when no env var, DB row, or default applies. */
export function getProviderMinuteRequestCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_MINUTE_REQUEST_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  const persisted = withDb(db => {
    const row = db.prepare(
      'SELECT rpm_limit FROM built_in_provider_settings WHERE platform = ?',
    ).get(platform) as { rpm_limit: number | null } | undefined;
    return row?.rpm_limit ?? undefined;
  });
  if (persisted !== undefined) return persisted;
  return DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS[platform] ?? null;
}

/** Resolve the shared per-minute token cap for a provider account+key. */
export function getProviderMinuteTokenCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_MINUTE_TOKEN_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  const persisted = withDb(db => {
    const row = db.prepare(
      'SELECT tpm_limit FROM built_in_provider_settings WHERE platform = ?',
    ).get(platform) as { tpm_limit: number | null } | undefined;
    return row?.tpm_limit ?? undefined;
  });
  if (persisted !== undefined) return persisted;
  return DEFAULT_PROVIDER_MINUTE_TOKEN_CAPS[platform] ?? null;
}

function countPersistedProviderMinuteRequests(
  platform: string,
  keyId: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, keyId, now - MINUTE) as { used: number };
    return row.used;
  });
}

function sumPersistedProviderMinuteTokens(
  platform: string,
  keyId: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND key_id = ?
         AND kind = 'tokens'
         AND created_at_ms > ?
    `).get(platform, keyId, now - MINUTE) as { used: number };
    return row.used;
  });
}

// Total requests in the last minute for a provider account+key, summed across
// every model — the account-shared per-minute usage the upstream actually sees.
export function providerMinuteRequestCount(platform: string, keyId: number, now = Date.now()): number {
  const provisional = provisionalSummary(platform, keyId, now - MINUTE).count;
  const persisted = countPersistedProviderMinuteRequests(platform, keyId, now);
  if (persisted !== undefined) return persisted + provisional;
  // DB-unavailable fallback: sum the per-model rpm windows for this platform+key.
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:rpm`)) {
      total += pruneTimestamps(w.timestamps, MINUTE, now).length;
    }
  }
  return total + provisional;
}

// Total tokens in the last minute for a provider account+key, summed across
// every model.
export function providerMinuteTokenCount(platform: string, keyId: number, now = Date.now()): number {
  const provisional = provisionalSummary(platform, keyId, now - MINUTE).tokens;
  const persisted = sumPersistedProviderMinuteTokens(platform, keyId, now);
  if (persisted !== undefined) return persisted + provisional;
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:tpm`)) {
      for (const t of w.tokenTimestamps ?? []) {
        if (t.ts > now - MINUTE) total += t.tokens;
      }
    }
  }
  return total + provisional;
}

// False when this provider account+key has hit its shared per-minute request OR
// token cap, so the router skips every model on that provider for this key
// until the minute window slides. Different keys on the same provider each
// have their own account budget, so the router still rotates across keys.
export function canUseProviderMinute(
  platform: string,
  keyId: number,
  estimatedTokens: number,
  now = Date.now(),
): boolean {
  const rpmCap = getProviderMinuteRequestCap(platform);
  if (rpmCap !== null && providerMinuteRequestCount(platform, keyId, now) >= rpmCap) return false;
  const tpmCap = getProviderMinuteTokenCap(platform);
  if (tpmCap !== null) {
    const used = providerMinuteTokenCount(platform, keyId, now);
    if (used + estimatedTokens > tpmCap) return false;
  }
  return true;
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  getWindow(rpmKey).timestamps.push(now);

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  getWindow(rpdKey).timestamps.push(now);

  recordUsage(platform, modelId, keyId, 'request', 0, now);
  // The fact that we just served a request through this key is the
  // strongest possible signal that it's not actually broken — promote
  // it back to 'healthy' if a transport error had previously marked it
  // 'error'. Cheap (one indexed UPDATE) and self-healing: keys stuck
  // on 'error' from a past network blip get cleared on their next use.
  markKeyHealthyFromRequest(keyId);
}

export function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  const now = Date.now();

  const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
  getWindow(tpmKey).tokenTimestamps.push({ ts: now, tokens });

  const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
  getWindow(tpdKey).tokenTimestamps.push({ ts: now, tokens });

  recordUsage(platform, modelId, keyId, 'tokens', tokens, now);
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

// X1: every cooldown after ANY upstream error is flat 90s. No escalation
// ladder, no payment-required 1-day branch, no daily-quota quarantine, no
// upstream-header-derived duration. Per-MINUTE pre-call gates stay (rpm/tpm/
// canUseProviderMinute — ~60s natural reset). Per-DAY gates removed.
const TRANSIENT_COOLDOWN_MS = 90 * 1000;

/** Compute the cooldown duration for a retryable error. X1: always returns
 *  the flat transient cooldown. The isPaymentRequired param is retained for
 *  C1 (cooldown-reason recording) but does not affect duration. */
export function computeRetryCooldownMs(
  _isPaymentRequired: boolean,
): number {
  return TRANSIENT_COOLDOWN_MS;
}

function persistedCooldownExpiry(
  platform: string,
  modelId: string,
  keyId: number,
): number | null | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT expires_at_ms
        FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).get(platform, modelId, keyId) as { expires_at_ms: number } | undefined;
    return row?.expires_at_ms ?? null;
  });
}

function persistCooldown(
  platform: string,
  modelId: string,
  keyId: number,
  expiresAtMs: number,
  reason?: string,
  statusCode?: number,
) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms, reason, status_code, set_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms,
                     reason = excluded.reason,
                     status_code = excluded.status_code,
                     set_at_ms = excluded.set_at_ms
    `).run(platform, modelId, keyId, expiresAtMs, reason ?? null, statusCode ?? null, Date.now());
  });
}

function clearPersistedCooldown(platform: string, modelId: string, keyId: number) {
  withDb(db => {
    db.prepare(`
      DELETE FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).run(platform, modelId, keyId);
  });
}

export function setCooldown(
  platform: string,
  modelId: string,
  keyId: number,
  durationMs = 90_000,
  reason?: string,
  statusCode?: number,
) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  persistCooldown(platform, modelId, keyId, expiresAtMs, reason, statusCode);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  // M11: memory-first — setCooldown() writes to both memory and DB, so a
  // hit here is authoritative and saves a SQLite round-trip that runs once
  // per (key × model) in the router's outer loop.
  const memoryExpiry = cooldowns.get(key);
  if (memoryExpiry !== undefined) {
    if (now > memoryExpiry) {
      cooldowns.delete(key);
      clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    return true;
  }
  // Not in memory: check the persistent store (covers cross-process
  // cooldowns written before this process started). Hydrate memory on hit.
  const persistedExpiry = persistedCooldownExpiry(platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }
  return false;
}


/** Clear all in-memory rate-limit state for a platform (cooldowns, windows, hit counters).
 *  Called when a custom provider is deleted so stale entries don't accumulate. */
export function clearPlatformCaches(platform: string): void {
  const prefix = `${platform}:`;
  for (const key of cooldowns.keys()) {
    if (key.startsWith(prefix)) cooldowns.delete(key);
  }
  for (const key of windows.keys()) {
    if (key.startsWith(prefix)) windows.delete(key);
  }
  for (const [id, r] of reservations) {
    if (r.platform === platform) reservations.delete(id);
  }
}

/** Clear all rate-limit state for one key — in-memory (cooldowns, windows,
 *  provisional reservations) and persisted (cooldown + usage rows). Called
 *  when a key is deleted so stale entries don't linger until their TTLs.
 *  Window keys are "platform:modelId:keyId:type" and modelId may contain ':',
 *  so the keyId is matched positionally from the end, never by substring. */
export function clearKeyRuntimeState(keyId: number): void {
  const matchesKey = (key: string): boolean => {
    const type = key.slice(key.lastIndexOf(':') + 1);
    if (type !== 'rpm' && type !== 'rpd' && type !== 'tpm' && type !== 'tpd' && type !== 'cooldown') return false;
    const rest = key.slice(0, key.lastIndexOf(':'));
    return Number(rest.slice(rest.lastIndexOf(':') + 1)) === keyId;
  };
  for (const key of cooldowns.keys()) {
    if (matchesKey(key)) cooldowns.delete(key);
  }
  for (const key of windows.keys()) {
    if (matchesKey(key)) windows.delete(key);
  }
  for (const [id, r] of reservations) {
    if (r.keyId === keyId) {
      reservations.delete(id);
      const leaves = pairLeaves.get(`${r.platform}:${keyId}`);
      if (leaves) removeLeaf(leaves, id);
    }
  }
  withDb(db => {
    db.prepare('DELETE FROM rate_limit_cooldowns WHERE key_id = ?').run(keyId);
    db.prepare('DELETE FROM rate_limit_usage WHERE key_id = ?').run(keyId);
  });
}
