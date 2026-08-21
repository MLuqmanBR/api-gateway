/**
 * F10: Circuit breaker — CLOSED/OPEN/HALF_OPEN per (platform, model, keyId).
 *
 * D-FEATURES-7 = per-(platform, model, keyId) — only the exact combo that
 * failed N times in a row is skipped. Other keys and other models keep working.
 *
 * State machine:
 *   CLOSED    → N consecutive failures → OPEN
 *   OPEN      → after cooldown_ms → HALF_OPEN
 *   HALF_OPEN → 1 probe attempt: success → CLOSED, failure → OPEN (cooldown×2)
 *   OPEN×3    → contributes to markExhausted (feeds the 1-RPM recovery loop)
 *
 * Attribution: circuit-breaker pattern from litellm (MIT, litellm/proxy/utils.py).
 */

import { parseIntSetting } from '../lib/settings-parse.js';

type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  cooldownMs: number;
  openCount: number; // times re-opened
}

const circuits = new Map<string, CircuitEntry>();

function circuitKey(platform: string, model: string, keyId: number): string {
  return `${platform}:${model}:${keyId}`;
}

function getThresholds() {
  // M20: NaN-safe parsing — a corrupt setting value previously poisoned
  // every threshold comparison (NaN > x is false), silently disabling the
  // breaker. parseIntSetting falls back to the numeric default and logs once.
  return {
    failureThreshold: parseIntSetting('circuit_breaker_failure_threshold', 5),
    cooldownMs: parseIntSetting('circuit_breaker_cooldown_ms', 30000),
    maxReopens: parseIntSetting('circuit_breaker_max_reopens', 3),
  };
}

/** Check if a circuit is open (should skip this provider+model+key).
 * If the cooldown has elapsed, transitions OPEN → HALF_OPEN and returns
 * false (allowing one probe attempt). */
export function isCircuitOpen(platform: string, model: string, keyId: number): boolean {
  const key = circuitKey(platform, model, keyId);
  const entry = circuits.get(key);
  if (!entry || entry.state === 'closed') return false;

  if (entry.state === 'open') {
    const now = Date.now();
    if (now - entry.openedAt >= entry.cooldownMs) {
      // Transition to HALF_OPEN — allow one probe
      entry.state = 'half_open';
      return false;
    }
    return true;
  }

  // half_open: only the probe request is allowed; subsequent requests are
  // blocked until the probe resolves (recordSuccess/recordFailure)
  return true;
}

/** Record a success — resets the circuit to CLOSED. */
export function recordCircuitSuccess(platform: string, model: string, keyId: number): void {
  const key = circuitKey(platform, model, keyId);
  const entry = circuits.get(key);
  if (!entry) return;
  entry.state = 'closed';
  entry.consecutiveFailures = 0;
  entry.openCount = 0;
}

/** Record a failure — increments the failure counter; opens the circuit
 * if the threshold is reached. Returns true if the circuit just opened. */
export function recordCircuitFailure(platform: string, model: string, keyId: number): boolean {
  const key = circuitKey(platform, model, keyId);
  const thresholds = getThresholds();
  let entry = circuits.get(key);
  if (!entry) {
    entry = { state: 'closed', consecutiveFailures: 0, openedAt: 0, cooldownMs: thresholds.cooldownMs, openCount: 0 };
    circuits.set(key, entry);
  }

  if (entry.state === 'half_open') {
    // Probe failed — re-open with doubled cooldown
    entry.state = 'open';
    entry.openedAt = Date.now();
    entry.openCount++;
    entry.cooldownMs = Math.min(entry.cooldownMs * 2, 300_000); // cap at 5 min
    return true;
  }

  entry.consecutiveFailures++;
  if (entry.consecutiveFailures >= thresholds.failureThreshold && entry.state === 'closed') {
    entry.state = 'open';
    entry.openedAt = Date.now();
    entry.cooldownMs = thresholds.cooldownMs;
    entry.openCount = 1;
    return true;
  }

  // Check if re-opened max times → contribute to markExhausted
  if (entry.openCount >= thresholds.maxReopens) {
    return true; // signal to caller to markExhausted
  }

  return false;
}

/** Check if a circuit has been re-opened enough times to warrant exhaustion. */
export function shouldMarkExhausted(platform: string, model: string, keyId: number): boolean {
  const key = circuitKey(platform, model, keyId);
  const entry = circuits.get(key);
  if (!entry) return false;
  const thresholds = getThresholds();
  return entry.openCount >= thresholds.maxReopens;
}

/** Get all circuit states (for /api/circuits admin route). */
export function getAllCircuits(): Array<{ key: string; state: CircuitState; consecutiveFailures: number; openCount: number }> {
  return [...circuits.entries()].map(([key, entry]) => ({
    key,
    state: entry.state,
    consecutiveFailures: entry.consecutiveFailures,
    openCount: entry.openCount,
  }));
}

/** Reset a specific circuit (for admin/testing). */
export function resetCircuit(platform: string, model: string, keyId: number): void {
  circuits.delete(circuitKey(platform, model, keyId));
}

/** Reset all circuits (for tests). */
export function resetAllCircuits(): void {
  circuits.clear();
}
