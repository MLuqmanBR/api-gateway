import { Notification } from 'electron';
import { getDb } from './server.mjs';
interface ExhaustedKey {
  id: number;
  platform: string;
  key_label: string;
}

/** Track state we've already notified about so we don't spam. */
let lastExhaustedIds = new Set<number>();
let lastErrorRatePct = -1;
let notifiedErrorSpike = false;

/** Poll the DB for noteworthy events. Returns true if a notification was shown. */
export function pollNotifications(): boolean {
  try {
    const db = getDb();
    if (!db) return false;

    // ── Key exhaustion ──────────────────────────────────────────────────
    // Find keys that crossed from non-exhausted to exhausted since last poll.
    const now = Date.now();
    const exhausted = db
      .prepare(
        `SELECT id, platform, key_label FROM api_keys
         WHERE enabled = 0 AND last_exhausted_at IS NOT NULL
         ORDER BY id`,
      )
      .all() as ExhaustedKey[];

    const currentIds = new Set(exhausted.map((k) => k.id));
    const newlyExhausted = exhausted.filter((k) => !lastExhaustedIds.has(k.id));
    lastExhaustedIds = currentIds;

    for (const key of newlyExhausted) {
      show(`⚠ Key exhausted: ${key.platform}/${key.key_label}`,
        'The key has been automatically disabled. You can re-enable it from the dashboard.');
    }

    // ── Error rate spike ────────────────────────────────────────────────
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'error' OR status = 'rate_limited' THEN 1 ELSE 0 END) AS errors
         FROM requests
         WHERE created_at >= datetime('now', '-1 hour')`,
      )
      .get() as { total: number; errors: number } | undefined;

    if (stats && stats.total >= 5) {
      const rate = Math.round((stats.errors / stats.total) * 100);
      if (rate >= 50 && !notifiedErrorSpike) {
        show(`⚠ High error rate: ${rate}%`,
          `${stats.errors} of ${stats.total} requests failed in the last hour. Check the dashboard for details.`);
        notifiedErrorSpike = true;
      } else if (rate < 30) {
        notifiedErrorSpike = false;
      }
      lastErrorRatePct = rate;
    }

    return newlyExhausted.length > 0;
  } catch {
    return false;
  }
}

function show(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    // Handled by the popover preload: clicking a notification opens the dashboard.
  });
  n.show();
}
