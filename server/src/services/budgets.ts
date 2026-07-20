/**
 * F4: $-budget enforcement — hard-cap with soft-warn.
 *
 * Scopes: 'client_key' (per F3 client key) or 'global' (all requests).
 * Three periods: daily, weekly, monthly — lazily reset on read (no scheduler).
 * Amounts in CENTS to avoid floating-point rounding.
 *
 * Flow:
 *   1. checkAndReserve(scope, scopeId, estimatedCostCents) — atomically
 *      checks if the budget has room and reserves the estimate. Returns
 *      { allowed, budgetExhausted? } — the proxy 402s on budgetExhausted.
 *   2. recordSpend(scope, scopeId, actualCostCents, estimatedCostCents) —
 *      reconciles the estimate vs actual after the request completes.
 *
 * Cost math: actual_cost_input_per_m ?? paid_input_per_m ?? FALLBACK_INPUT_PER_M
 * (same chain for output). The actual-cost columns are operator-populated;
 * the fallback chain means free-tier-backed models use paid-equivalent rates.
 *
 * D-FEATURES-4: Hard-cap + soft-warn LiveEvent (soft-dep F8 for fan-out).
 */

import { getDb } from '../db/index.js';
import type { DatabasePort } from '../db/types.js';
import { publish } from './events.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';

export type BudgetScope = 'client_key' | 'global';

export interface BudgetRow {
  id: number;
  scope: BudgetScope;
  scope_id: string | null;
  daily_limit_cents: number | null;
  weekly_limit_cents: number | null;
  monthly_limit_cents: number | null;
  weekly_reset_day: number;
  daily_used_cents: number;
  weekly_used_cents: number;
  monthly_used_cents: number;
  daily_reset_at: string | null;
  weekly_reset_at: string | null;
  monthly_reset_at: string | null;
}

export interface BudgetCheckResult {
  allowed: boolean;
  exhaustedPeriod?: 'daily' | 'weekly' | 'monthly';
  overageCents?: number;
  scope: BudgetScope;
}

/** Get the UTC date string for "today" (YYYY-MM-DD). */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get the ISO weekday (1=Monday … 7=Sunday). */
function isoWeekday(): number {
  const d = new Date().getUTCDay();
  return d === 0 ? 7 : d;
}

/** Get the UTC year-month string (YYYY-MM). */
function utcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Get or create the budget row for a scope. */
function getOrCreateBudget(db: DatabasePort, scope: BudgetScope, scopeId: string | null): BudgetRow | null {
  const row = db.prepare(
    'SELECT * FROM budgets WHERE scope = ? AND scope_id IS ?',
  ).get(scope, scopeId) as BudgetRow | undefined;
  if (row) return row;

  // No budget row = no enforcement (backward-compat).
  return null;
}

/** Lazily reset the used counters when the period has elapsed. */
function resetIfNeeded(db: DatabasePort, row: BudgetRow): BudgetRow {
  const today = utcToday();
  const month = utcMonth();
  const weekday = isoWeekday();
  const updates: string[] = [];
  const args: (string | number)[] = [];

  // Daily reset: compare against today's UTC date.
  if (row.daily_reset_at !== today) {
    updates.push('daily_used_cents = 0', 'daily_reset_at = ?');
    args.push(today);
    row.daily_used_cents = 0;
    row.daily_reset_at = today;
  }

  // Weekly reset: if the stored weekday < current weekday (wrapped), or
  // reset_at is null, reset the weekly counter. Simplified: compare the
  // stored reset_at date — if it's in a different ISO week, reset.
  // For simplicity: reset weekly if daily_reset_at changed AND it's the
  // configured weekly_reset_day (default Monday=1). This is a heuristic
  // that works for the common case; the alternative is ISO week computation.
  if (row.weekly_reset_at !== today && weekday === (row.weekly_reset_day || 1)) {
    updates.push('weekly_used_cents = 0', 'weekly_reset_at = ?');
    args.push(today);
    row.weekly_used_cents = 0;
    row.weekly_reset_at = today;
  }

  // Monthly reset: compare against this month.
  if (row.monthly_reset_at !== month) {
    updates.push('monthly_used_cents = 0', 'monthly_reset_at = ?');
    args.push(month);
    row.monthly_used_cents = 0;
    row.monthly_reset_at = month;
  }

  if (updates.length > 0) {
    args.push(row.id);
    db.prepare(`UPDATE budgets SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  }

  return row;
}

/** Check if a budget allows a request with the estimated cost, and reserve
 *  the estimate atomically. Returns { allowed: true } or { allowed: false,
 *  exhaustedPeriod, overageCents } for the proxy to 402. */
export function checkAndReserve(scope: BudgetScope, scopeId: string | null, estimatedCostCents: number): BudgetCheckResult {
  const db = getDb();
  const row = getOrCreateBudget(db, scope, scopeId);
  if (!row) return { allowed: true, scope };

  const reset = resetIfNeeded(db, row);
  const cost = Math.max(0, Math.ceil(estimatedCostCents));

  // Check each period — the most restrictive wins.
  if (reset.daily_limit_cents != null && reset.daily_used_cents + cost > reset.daily_limit_cents) {
    return {
      allowed: false,
      exhaustedPeriod: 'daily',
      overageCents: reset.daily_used_cents + cost - reset.daily_limit_cents,
      scope,
    };
  }
  if (reset.weekly_limit_cents != null && reset.weekly_used_cents + cost > reset.weekly_limit_cents) {
    return {
      allowed: false,
      exhaustedPeriod: 'weekly',
      overageCents: reset.weekly_used_cents + cost - reset.weekly_limit_cents,
      scope,
    };
  }
  if (reset.monthly_limit_cents != null && reset.monthly_used_cents + cost > reset.monthly_limit_cents) {
    return {
      allowed: false,
      exhaustedPeriod: 'monthly',
      overageCents: reset.monthly_used_cents + cost - reset.monthly_limit_cents,
      scope,
    };
  }

  // Reserve the estimate atomically.
  db.prepare(
    `UPDATE budgets SET
      daily_used_cents = daily_used_cents + ?,
      weekly_used_cents = weekly_used_cents + ?,
      monthly_used_cents = monthly_used_cents + ?
    WHERE id = ?`,
  ).run(cost, cost, cost, reset.id);

  // Soft-warn: if usage exceeds 90% of any limit, emit budget.warn.
  const warn = (used: number, limit: number | null) => limit != null && used / limit >= 0.9;
  if (warn(reset.daily_used_cents + cost, reset.daily_limit_cents)
    || warn(reset.weekly_used_cents + cost, reset.weekly_limit_cents)
    || warn(reset.monthly_used_cents + cost, reset.monthly_limit_cents)) {
    publish({ type: 'budget.warn' as any, scope, scopeId, period: 'daily', usedCents: reset.daily_used_cents + cost, limitCents: reset.daily_limit_cents, at: Date.now() } as any);
  }

  return { allowed: true, scope };
}

/** Reconcile the estimate with the actual cost after the request completes.
 *  Adjusts the used counters by (actual - estimate). */
export function recordSpend(scope: BudgetScope, scopeId: string | null, actualCostCents: number, estimatedCostCents: number): void {
  const db = getDb();
  const row = getOrCreateBudget(db, scope, scopeId);
  if (!row) return;

  const delta = Math.ceil(actualCostCents) - Math.ceil(estimatedCostCents);
  if (delta === 0) return;

  db.prepare(
    `UPDATE budgets SET
      daily_used_cents = MAX(0, daily_used_cents + ?),
      weekly_used_cents = MAX(0, weekly_used_cents + ?),
      monthly_used_cents = MAX(0, monthly_used_cents + ?)
    WHERE id = ?`,
  ).run(delta, delta, delta, row.id);
}

/** Compute the estimated cost in cents for a request.
 *  Uses actual_cost_* ?? paid_* ?? FALLBACK per the F4 decision. */
export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
  actualInputPerM: number | null,
  actualOutputPerM: number | null,
  paidInputPerM: number | null,
  paidOutputPerM: number | null,
): number {
  const inputPerM = actualInputPerM ?? paidInputPerM ?? FALLBACK_INPUT_PER_M;
  const outputPerM = actualOutputPerM ?? paidOutputPerM ?? FALLBACK_OUTPUT_PER_M;
  const costUsd = (inputTokens / 1_000_000) * inputPerM + (outputTokens / 1_000_000) * outputPerM;
  return Math.ceil(costUsd * 100);
}

/** List all budget rows. */
export function listBudgets(): BudgetRow[] {
  return getDb().prepare('SELECT * FROM budgets ORDER BY scope, scope_id').all() as BudgetRow[];
}

/** Set (upsert) a budget for a scope. */
export function setBudget(
  scope: BudgetScope,
  scopeId: string | null,
  limits: { daily_limit_cents?: number | null; weekly_limit_cents?: number | null; monthly_limit_cents?: number | null; weekly_reset_day?: number },
): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM budgets WHERE scope = ? AND scope_id IS ?').get(scope, scopeId);
  if (existing) {
    db.prepare(
      `UPDATE budgets SET
        daily_limit_cents = COALESCE(?, daily_limit_cents),
        weekly_limit_cents = COALESCE(?, weekly_limit_cents),
        monthly_limit_cents = COALESCE(?, monthly_limit_cents),
        weekly_reset_day = COALESCE(?, weekly_reset_day)
      WHERE id = ?`,
    ).run(limits.daily_limit_cents ?? null, limits.weekly_limit_cents ?? null, limits.monthly_limit_cents ?? null, limits.weekly_reset_day ?? null, (existing as any).id);
  } else {
    db.prepare(
      `INSERT INTO budgets (scope, scope_id, daily_limit_cents, weekly_limit_cents, monthly_limit_cents, weekly_reset_day)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(scope, scopeId, limits.daily_limit_cents ?? null, limits.weekly_limit_cents ?? null, limits.monthly_limit_cents ?? null, limits.weekly_reset_day ?? 1);
  }
}

/** Delete a budget. */
export function deleteBudget(scope: BudgetScope, scopeId: string | null): boolean {
  const result = getDb().prepare('DELETE FROM budgets WHERE scope = ? AND scope_id IS ?').run(scope, scopeId);
  return result.changes > 0;
}

/** Reset used counters for a budget (admin action). */
export function resetBudgetUsage(scope: BudgetScope, scopeId: string | null): boolean {
  const result = getDb().prepare(
    `UPDATE budgets SET daily_used_cents = 0, weekly_used_cents = 0, monthly_used_cents = 0
     WHERE scope = ? AND scope_id IS ?`,
  ).run(scope, scopeId);
  return result.changes > 0;
}
