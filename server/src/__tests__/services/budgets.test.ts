import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  checkAndReserve, recordSpend, estimateCostCents,
  setBudget, listBudgets, deleteBudget, resetBudgetUsage,
  type BudgetScope,
} from '../../services/budgets.js';

describe('Budgets service (F4)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM budgets').run();
  });

  it('allows all when no budget row exists (backward-compat)', () => {
    const result = checkAndReserve('client_key', 'ck_test123', 1000);
    expect(result.allowed).toBe(true);
  });

  it('rejects when daily limit is exceeded', () => {
    setBudget('client_key' as BudgetScope, 'ck_test1', { daily_limit_cents: 500 });
    const ok = checkAndReserve('client_key', 'ck_test1', 300);
    expect(ok.allowed).toBe(true);
    const blocked = checkAndReserve('client_key', 'ck_test1', 300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.exhaustedPeriod).toBe('daily');
    expect(blocked.overageCents).toBe(100);
  });

  it('rejects when monthly limit is exceeded', () => {
    setBudget('client_key' as BudgetScope, 'ck_test2', { monthly_limit_cents: 1000 });
    const ok = checkAndReserve('client_key', 'ck_test2', 600);
    expect(ok.allowed).toBe(true);
    const blocked = checkAndReserve('client_key', 'ck_test2', 500);
    expect(blocked.allowed).toBe(false);
    expect(blocked.exhaustedPeriod).toBe('monthly');
  });

  it('reserves and reconciles estimate vs actual', () => {
    setBudget('client_key' as BudgetScope, 'ck_test3', { daily_limit_cents: 1000 });
    checkAndReserve('client_key', 'ck_test3', 500);
    // Actual was only 300 — refund the 200 difference
    recordSpend('client_key', 'ck_test3', 300, 500);
    // Should now have 200 remaining (1000 - 300 actual)
    const ok = checkAndReserve('client_key', 'ck_test3', 200);
    expect(ok.allowed).toBe(true);
  });

  it('estimateCostCents uses actual ?? paid ?? FALLBACK chain', () => {
    // With actual cost
    const withActual = estimateCostCents(1_000_000, 0, 5.0, 15.0, 1.0, 2.0);
    expect(withActual).toBe(500); // 1M tokens * $5/M = $5 = 500 cents

    // Falls back to paid when actual is null
    const withPaid = estimateCostCents(1_000_000, 0, null, null, 2.0, 6.0);
    expect(withPaid).toBe(200); // 1M tokens * $2/M = $2 = 200 cents

    // Falls back to FALLBACK when both are null
    const withFallback = estimateCostCents(1_000_000, 0, null, null, null, null);
    expect(withFallback).toBe(20); // 1M tokens * $0.20/M = $0.20 = 20 cents
  });

  it('listBudgets returns all rows', () => {
    setBudget('client_key' as BudgetScope, 'ck_a', { daily_limit_cents: 100 });
    setBudget('global' as BudgetScope, null, { monthly_limit_cents: 5000 });
    const all = listBudgets();
    expect(all).toHaveLength(2);
  });

  it('deleteBudget removes a row', () => {
    setBudget('client_key' as BudgetScope, 'ck_del', { daily_limit_cents: 100 });
    expect(deleteBudget('client_key', 'ck_del')).toBe(true);
    expect(deleteBudget('client_key', 'ck_del')).toBe(false);
  });

  it('resetBudgetUsage zeros out the counters', () => {
    setBudget('client_key' as BudgetScope, 'ck_reset', { daily_limit_cents: 1000 });
    checkAndReserve('client_key', 'ck_reset', 500);
    expect(resetBudgetUsage('client_key', 'ck_reset')).toBe(true);
    const budgets = listBudgets();
    const b = budgets.find(b => b.scope_id === 'ck_reset');
    expect(b?.daily_used_cents).toBe(0);
  });

  it('global scope works with null scope_id', () => {
    setBudget('global' as BudgetScope, null, { daily_limit_cents: 100 });
    const ok = checkAndReserve('global', null, 50);
    expect(ok.allowed).toBe(true);
    const blocked = checkAndReserve('global', null, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.exhaustedPeriod).toBe('daily');
  });

  it('upserts a budget (sets new limits without deleting usage)', () => {
    setBudget('client_key' as BudgetScope, 'ck_upsert', { daily_limit_cents: 1000 });
    checkAndReserve('client_key', 'ck_upsert', 500);
    // Change the limit — usage should persist
    setBudget('client_key' as BudgetScope, 'ck_upsert', { daily_limit_cents: 2000 });
    const budgets = listBudgets();
    const b = budgets.find(b => b.scope_id === 'ck_upsert');
    expect(b?.daily_limit_cents).toBe(2000);
    expect(b?.daily_used_cents).toBe(500);
  });
});
