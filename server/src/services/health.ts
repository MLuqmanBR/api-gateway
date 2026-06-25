import { getDb } from '../db/index.js';
import { buildProviderFor } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { publish, type LiveEvent } from './events.js';
import type { KeyStatus } from '@api-gateway/shared/types.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Track consecutive failures per key
const failureCount = new Map<number, number>();

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = buildProviderFor(row.platform);
  if (!provider) return 'error';

  // Decrypt the stored key first — a failure here means the key is
  // permanently unreadable (wrong encryption key or corrupt data),
  // not a transient network issue.
  let apiKey: string;
  try {
    apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch (err: any) {
    console.error(`[Health] Key ${keyId} decrypt failed:`, err.message);
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', keyId);
    return 'error';
  }

  try {
    const isValid = await provider.validateKey(apiKey);

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    // Transport error (DNS / timeout / TLS) — the provider's validation endpoint
    // was unreachable, which is NOT a reliable signal that the key is bad.
    // A perfectly valid key can hit a transport hiccup and get marked
    // 'error', which excludes it from routeRequest (only 'healthy'/'unknown'
    // keys are picked). That makes the user see "my key works fine but the
    // gateway says it's broken" — the exact symptom this fix targets.
    //
    // Behavior on transport error:
    //   1. Log the error so the operator can see it in the API log.
    //   2. Update `last_checked_at` so the UI shows "we tried, just now".
    //   3. DO NOT change `status`. If the key was 'healthy' or 'unknown'
    //      before, it stays that way — the next successful chat request
    //      will refresh the timestamp; the next health check will retry.
    //      If the key was already 'invalid' or 'error', we keep that label
    //      so the operator can still see the prior diagnosis.
    //
    // Auto-disable is intentionally NEVER triggered by transport errors —
    // only confirmed 401/403 from validateKey (returned as `false`) count
    // toward the consecutive-failure threshold.
    console.error(`[Health] Key ${keyId} transport error:`, err.message);
    db.prepare("UPDATE api_keys SET last_checked_at = datetime('now') WHERE id = ?")
      .run(keyId);
    // Return the prior status so the caller / UI can show it without
    // re-querying. (We re-read the row rather than caching the prior
    // value in code so this stays correct under concurrent writes.)
    const after = db.prepare('SELECT status FROM api_keys WHERE id = ?').get(keyId) as { status: KeyStatus } | undefined;
    return after?.status ?? 'unknown';
  }
}
// How many keys to validate in parallel during `checkAllKeys`. The previous
// sequential loop took 15+ minutes for 89 keys at the per-key 30s timeout —
// the user got no UI feedback the entire time. A small bounded pool keeps
// upstream providers happy (they all rate-limit health probes too) while
// still finishing ~8x faster. The pool size is conservative; raise it via
// HEALTH_CHECK_CONCURRENCY if your providers can handle it.
const DEFAULT_CHECK_CONCURRENCY = 8;
const CHECK_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.HEALTH_CHECK_CONCURRENCY ?? '', 10) || DEFAULT_CHECK_CONCURRENCY,
);

export async function checkAllKeys(): Promise<void> {
  const db = getDb();
  const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

  // Synthetic `id` per emission so the event satisfies LiveEventBase.id
  // on the client. Health events aren't request-scoped — they describe a
  // background sweep — so a per-emission id is the only sensible value.
  // The `at` timestamp doubles as a tiebreaker if two emissions race.
  // Each call site builds the event literal directly (rather than going
  // through a generic `Omit<LiveEvent, 'id' | 'at'>` helper) because
  // the LiveEvent union distributes oddly under Omit — the type checker
  // ended up demanding fields that don't apply to the variant being
  // emitted. Direct literals with all required fields keep the call
  // sites self-documenting and the type-checker happy. (#256)
  const syntheticId = (): string => `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[Health] Checking ${keys.length} keys (concurrency ${CHECK_CONCURRENCY})...`);
  publish({
    type: 'health.check.start',
    id: syntheticId(),
    total: keys.length,
    concurrency: CHECK_CONCURRENCY,
    at: Date.now(),
  });

  let completed = 0;
  let next = 0;
  // Bounded-pool worker. Each worker pulls the next index, validates it,
  // publishes a per-key progress event, and repeats until the queue is
  // empty. Using an index cursor (not Array.prototype.shift) keeps the
  // dispatch O(1) and makes the ordering deterministic-ish: earlier keys
  // start first, but faster validations finish first.
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= keys.length) return;
      const key = keys[i];
      const status = await checkKeyHealth(key.id);
      completed++;
      publish({
        type: 'health.check.progress',
        id: syntheticId(),
        keyId: key.id,
        platform: key.platform,
        status,
        completed,
        total: keys.length,
        at: Date.now(),
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, keys.length) }, () => worker()),
  );

  console.log(`[Health] Check complete (${completed}/${keys.length}).`);
  publish({ type: 'health.check.done', id: syntheticId(), total: keys.length, at: Date.now() });
}

let intervalId: ReturnType<typeof setInterval> | null = null;

// Reset any key that was previously marked 'error' back to 'unknown' so the
// next health check (or the next successful chat request) gets a chance to
// confirm it. The 'error' label is only ever applied by the health checker
// catching a transport error, and a transport error is NOT a reliable
// signal that the key is bad — it's just a signal that the provider's
// validation endpoint was momentarily unreachable. Many keys get stuck on
// 'error' for hours after a brief network blip, and the user has to wait
// for the 5-minute health-check cycle to flip them back. Calling this on
// startup means a freshly-restarted gateway doesn't inherit the previous
// instance's false negatives. (#256)
export function resetErrorStatuses(): void {
  const db = getDb();
  const result = db.prepare(
    "UPDATE api_keys SET status = 'unknown' WHERE status = 'error'"
  ).run();
  if (result.changes > 0) {
    console.log(`[Health] Reset ${result.changes} key(s) from 'error' to 'unknown' on startup`);
  }
}

export function startHealthChecker(): void {
  if (intervalId) return;
  // Clear any transport-error residue before the first check. Without this,
  // a key that was marked 'error' 4 minutes before restart would sit on
  // 'error' for another 5 minutes (until the next health check) — and
  // routeRequest excludes 'error' keys, so every request would route
  // around it for no good reason.
  resetErrorStatuses();
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s, concurrency ${CHECK_CONCURRENCY})`);
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

// Promote a key from 'error' (or any non-healthy) status back to 'healthy'
// when it actually serves a successful chat request. This is the recovery
// path for keys that were stuck on 'error' due to a transport hiccup but
// are in fact fine — the first successful chat call proves it. The proxy
// calls this from `recordRequest` so it stays correct without coupling the
// proxy to the health module's internals. (#256)
export function markKeyHealthyFromRequest(keyId: number): void {
  try {
    const db = getDb();
    // Only flip from 'error' / 'unknown' — never downgrade a confirmed
    // 'invalid' (401/403 from the provider). If the key is genuinely
    // rejected, the proxy will surface that on the very next call.
    db.prepare(
      "UPDATE api_keys SET status = 'healthy', last_checked_at = datetime('now') WHERE id = ? AND status IN ('error', 'unknown')"
    ).run(keyId);
  } catch {
    // The DB might not be initialized yet (early startup, test setup, etc).
    // Best-effort recovery — the next successful request will retry.
  }
}
