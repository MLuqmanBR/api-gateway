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
  reservations.set(id, { platform, modelId, keyId, ts: Date.now(), tokens });
  return id;
}

/** Release a reservation. Idempotent — a missing id is a no-op. */
export function releaseReservation(id: number): void {
  reservations.delete(id);
}

/** Summarize provisional reservations for a platform+key, optionally
 *  filtered by modelId. Returns { count, tokens } in one pass. */
function provisionalSummary(
  platform: string,
  keyId: number,
  cutoff: number,
  modelId?: string,
): { count: number; tokens: number } {
  let count = 0, tokens = 0;
  for (const r of reservations.values()) {
    if (r.keyId === keyId && r.ts > cutoff && r.platform === platform &&
        (modelId === undefined || r.modelId === modelId)) {
      count++;
      tokens += r.tokens;
    }
  }
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
    db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, kind, tokens, now);
    db.prepare('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?').run(now - DAY);
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

  if (limits.rpm !== null) {
    if (requestCount(platform, modelId, keyId, MINUTE, now) >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    if (requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd) return false;
  }

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

  if (limits.tpm !== null) {
    const used = tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const used = tokenCount(platform, modelId, keyId, DAY, now);
    if (used + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

// ── Provider-wide daily request caps (#162) ──
// Some providers enforce one daily REQUEST quota across the WHOLE account,
// shared by every model — not per model. OpenRouter's free tier is the classic
// case: ~1000 requests/day total (50/day if you've bought <10 credits) no
// matter how many different free models you spread them across. The
// per-(platform,model,key) rpd ledger can't see that, so without a provider-wide
// gate the router happily fires (models × rpd) requests and earns surprise 429s.
//
// Defaults below; override per provider with an env var, e.g.
//   PROVIDER_DAILY_REQUEST_CAP_OPENROUTER=50   (set 0 to disable the cap)
const DEFAULT_PROVIDER_DAILY_REQUEST_CAPS: Record<string, number> = {
  openrouter: 1000,
};

export function getProviderDailyRequestCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_DAILY_REQUEST_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_DAILY_REQUEST_CAPS[platform] ?? null;
}

// Total requests today for a provider account+key, summed across every model.
// Uses midnight-UTC epoch-ms for the cutoff so the gate resets at a fixed wall-clock
// boundary matching real provider caps (OpenRouter ~1000/day, NVIDIA per-account),
// rather than a sliding 24h window that benches providers past their true reset time.
export function providerDailyRequestCount(platform: string, keyId: number, now = Date.now()): number {
  const dayStartMs = new Date(now).setUTCHours(0, 0, 0, 0);
  const provisional = provisionalSummary(platform, keyId, dayStartMs).count;
  const persisted = withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, keyId, dayStartMs) as { used: number };
    return row.used;
  });
  if (persisted !== undefined) return persisted + provisional;
  // DB-unavailable fallback: sum the per-model rpd windows for this platform+key.
  // Window key format is "platform:modelId:keyId:rpd" (modelId may contain ':').
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:rpd`)) {
      total += w.timestamps.filter(ts => ts > dayStartMs).length;
    }
  }
  return total + provisional;
}

// False when this provider account+key has hit its shared daily request cap, so
// the router skips every model on that provider for this key until UTC midnight reset.
export function canUseProvider(platform: string, keyId: number, now = Date.now()): boolean {
  const cap = getProviderDailyRequestCap(platform);
  if (cap === null) return true;
  return providerDailyRequestCount(platform, keyId, now) < cap;
}
// ── Provider-wide per-minute caps (#295) ──
// Mirror of the provider-wide daily cap above, but per-minute. Some providers
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

// Escalating cooldown: track hits per key over a rolling 24h window so a
// daily-quota exhaustion (OpenRouter free: 50/day, Cohere free: 33/day, etc.)
// quarantines the key for the rest of the day instead of looping through
// the 2-minute cooldown 20 times per request and consuming every fallback slot.
// In-memory only — state resets on restart, which is fine (a clean restart
// will re-escalate on the next 429 if the quota is genuinely exhausted).
const cooldownHits = new Map<string, number[]>(); // key -> timestamps of recent cooldown set events
const HOUR = 60 * MINUTE;
const COOLDOWN_DURATIONS = [
  2 * MINUTE,   // 1st hit in 24h
  10 * MINUTE,  // 2nd
  HOUR,         // 3rd
  DAY,          // 4th and beyond
];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: number): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

// Short cooldown for a transient (per-minute) 429 — recovers within ~one window.
const TRANSIENT_COOLDOWN_MS = 90 * 1000;

// Long cooldown for a 402 Payment Required (provider/key out of credits). Unlike
// a 429, this won't clear on the next minute/day window — it needs a top-up or
// billing reset. Bench the model+key for a full day so the router fails over to
// other providers instead of re-hammering a dead key every retry. Re-escalates
// on the next 402 after expiry if still unpaid; a restart re-benches on first hit.
export const PAYMENT_REQUIRED_COOLDOWN_MS = DAY;

/** Compute the cooldown duration for a retryable error. Encapsulates the
 *  payment-required vs transient decision so both the proxy and responses
 *  routers apply the same policy. */
export function computeRetryCooldownMs(
  isPaymentRequired: boolean,
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpd: number | null; tpd: number | null },
  retryAfterMs?: number | null,
): number {
  if (isPaymentRequired) return PAYMENT_REQUIRED_COOLDOWN_MS;
  return getCooldownDurationForLimit(platform, modelId, keyId, limits, retryAfterMs);
}

// Decide how long to bench a model+key after an upstream 429. Escalate to the
// long quarantine (getNextCooldownDuration, up to 24h) ONLY when the model is
// genuinely at its DAILY limit (RPD or TPD) — that won't recover until the
// provider's daily reset, so a long bench avoids hammering a truly-dead key.
//
// A transient RPM/TPM 429 gets a short fixed cooldown and does NOT count toward
// escalation. This is the common case for providers with a tight per-minute
// token budget but a large daily quota — e.g. groq gpt-oss-120b has rpd=1000
// yet tpm=8000, so a single burst of large prompts 429s on TPM while the daily
// quota is barely touched. Without this split, those transient bursts escalated
// (2m → 10m → 1h → 24h) and quarantined a perfectly healthy provider for the
// rest of the day. Daily counters are persisted (countPersistedRequests /
// sumPersistedTokens), so this verdict is stable across restarts.
export function getCooldownDurationForLimit(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpd: number | null; tpd: number | null },
  retryAfterMs?: number | null,
): number {
  const now = Date.now();
  const rpdExhausted =
    limits.rpd !== null && requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd;
  const tpdExhausted =
    limits.tpd !== null && tokenCount(platform, modelId, keyId, DAY, now) >= limits.tpd;
  const base = (rpdExhausted || tpdExhausted)
    ? getNextCooldownDuration(platform, modelId, keyId)
    : TRANSIENT_COOLDOWN_MS;
  // Honor an upstream Retry-After as a floor: never bench shorter than our own
  // heuristic, but extend (capped at a day) when the provider explicitly asks
  // to wait longer than we otherwise would.
  if (retryAfterMs != null && retryAfterMs > base) return Math.min(retryAfterMs, DAY);
  return base;
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

function persistCooldown(platform: string, modelId: string, keyId: number, expiresAtMs: number) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `).run(platform, modelId, keyId, expiresAtMs);
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

export function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  persistCooldown(platform, modelId, keyId, expiresAtMs);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  const persistedExpiry = persistedCooldownExpiry(platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  return {
    rpm: { used: requestCount(platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: requestCount(platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: tokenCount(platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}

/** Clear all in-memory rate-limit state for a platform (cooldowns, windows, hit counters).
 *  Called when a custom provider is deleted so stale entries don't accumulate. */
export function clearPlatformCaches(platform: string): void {
  const prefix = `${platform}:`;
  for (const key of cooldowns.keys()) {
    if (key.startsWith(prefix)) cooldowns.delete(key);
  }
  for (const key of cooldownHits.keys()) {
    if (key.startsWith(prefix)) cooldownHits.delete(key);
  }
  for (const key of windows.keys()) {
    if (key.startsWith(prefix)) windows.delete(key);
  }
  for (const [id, r] of reservations) {
    if (r.platform === platform) reservations.delete(id);
  }
}
