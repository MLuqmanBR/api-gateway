import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// SQLite stores timestamps as `YYYY-MM-DD HH:MM:SS` with no timezone marker, so
// passing them straight to `new Date(...)` makes the browser read them as LOCAL
// time when they are actually UTC — shifting every displayed time by the
// viewer's offset. These helpers tag the value as UTC before parsing. (#170)

/** Convert a SQLite UTC datetime string into an ISO-8601 UTC string. */
export function sqliteUtcToIso(value: string): string {
  // Already ISO (has 'T' and a zone/offset)? Leave it alone.
  if (value.includes('T')) return value;
  return value.replace(' ', 'T') + 'Z';
}

/** Format a SQLite UTC datetime string as the viewer's local time-of-day. */
export function formatSqliteUtcToLocalTime(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' },
): string {
  if (!value) return '—';
  const date = new Date(sqliteUtcToIso(value));
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], options);
}

/**
 * Parse an ISO-8601 UTC timestamp and format it in the user's local timezone
 * for chart axis labels. Hourly gets abbreviated time; daily gets short date.
 */
export function formatIsoUtcToLocalChart(value: string, interval: 'hour' | 'day'): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  if (interval === 'hour') {
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
/**
 * Build a polished, sortable backup filename for a config export.
 *
 * Format:
 *   - No label:  `API_Gateway-Backup-YYYY-MM-DD-HH-mm-ss.json`
 *   - With label: `API_Gateway-Backup-<slug>-YYYY-MM-DD-HH-mm-ss.json`
 *
 * The timestamp is rendered in the *user's local timezone* (the browser
 * already knows it via `Intl.DateTimeFormat`), not UTC. Two-digit fields
 * are zero-padded so the resulting filename sorts lexicographically.
 *
 * The optional `label` ("Laptop staging", "Production") is slugified so
 * the operator can tell multiple exports apart at a glance. Slug rules:
 *   - lowercase, ASCII letters / digits / hyphens only
 *   - max 32 chars (truncated on a word boundary if possible)
 *   - leading/trailing hyphens stripped
 *   - non-Latin letters (e.g. Cyrillic) collapse to a dash so the
 *     filename stays portable across filesystems
 */
export function makeConfigBackupFilename(now: Date = new Date(), label?: string): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const slug = labelSlugify(label);
  return slug
    ? `API_Gateway-Backup-${slug}-${stamp}.json`
    : `API_Gateway-Backup-${stamp}.json`;
}

/**
 * Convert a free-form label into a filename-safe slug.
 * Returns an empty string when there's nothing useful to keep.
 */
function labelSlugify(label: string | undefined | null): string {
  if (!label) return '';
  // Replace runs of non-[a-z0-9] with a single hyphen; lowercase.
  const ascii = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining marks (e.g. é → e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!ascii) return '';
  // Truncate at a word boundary when possible to keep the slug readable.
  if (ascii.length <= 32) return ascii;
  const cut = ascii.slice(0, 32);
  const lastHyphen = cut.lastIndexOf('-');
  // Only use the cut if the boundary isn't too aggressive (< 50% loss).
  if (lastHyphen > 16) return cut.slice(0, lastHyphen);
  return cut.replace(/-+$/, '');
}

/**
 * Return the user's IANA timezone (e.g. `Europe/London`), falling back to
 * `UTC` if the browser doesn't expose the resolved name. Useful for
 * showing the operator which timezone a filename stamp represents.
 */
export function getLocalTimezoneName(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Trigger a browser file download for an in-memory payload.
 *
 * The standard pattern of `URL.createObjectURL(...) → anchor.click() →
 * URL.revokeObjectURL(url)` is racy in Firefox: revoking the URL on the
 * same tick as the click causes the browser to drop the download with
 * a "could not load XPCOM" error, and the file never reaches the
 * user's machine. We instead schedule the revoke on a `setTimeout(0)`
 * microtask plus a 1s safety net so the download has plenty of time to
 * read from the blob before the URL is invalidated.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    document.body.removeChild(anchor);
    // Defer the revoke so the browser can read the blob first. Two
    // timers cover both fast and slow pipelines:
    //   1. `setTimeout(0)` is enough for Chromium / WebKit.
    //   2. The 1s safety net catches Firefox and anything that
    //      dispatches the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
