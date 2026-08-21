/**
 * M20: NaN-safe numeric parsing for DB-backed settings.
 *
 * The previous pattern — `parseInt(getSetting(name) ?? '5', 10)` — returns NaN
 * when an operator writes a corrupt value ('abc', '', '12x'). NaN poisons every
 * downstream comparison (`NaN > 3` is false), silently disabling the feature:
 * the circuit breaker never opens, the cache TTL instantly expires entries,
 * queue thresholds vanish, compression limits no longer apply.
 *
 * These helpers fall back to the numeric default on NaN and log the corrupt
 * value ONCE per (setting, invalid-value) pair so triage can find the root
 * cause without a console flood.
 */

import { getSetting } from '../db/index.js';

const alreadyWarned = new Set<string>();

function warnOnce(name: string, raw: string | undefined, fallback: number): void {
  const key = `${name}:${raw}`;
  if (alreadyWarned.has(key)) return;
  alreadyWarned.add(key);
  process.stderr.write(
    `[Settings] Invalid numeric value for '${name}' (${raw === '' ? 'empty string' : JSON.stringify(raw)}) — using default ${fallback}\n`,
  );
}

/** Read an integer setting with a hard fallback on missing OR unparseable values. */
export function parseIntSetting(name: string, defaultValue: number): number {
  const raw = getSetting(name);
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    warnOnce(name, raw, defaultValue);
    return defaultValue;
  }
  return parsed;
}

/** Read a float setting with a hard fallback on missing OR unparseable values. */
export function parseFloatSetting(name: string, defaultValue: number): number {
  const raw = getSetting(name);
  if (raw === undefined) return defaultValue;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    warnOnce(name, raw, defaultValue);
    return defaultValue;
  }
  return parsed;
}
