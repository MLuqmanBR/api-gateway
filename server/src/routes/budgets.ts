/**
 * F4: /api/budgets — admin CRUD for $-spend caps.
 * Mount under /api (requireAuth blanket). Amounts in cents.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listBudgets, setBudget, deleteBudget, resetBudgetUsage, type BudgetScope } from '../services/budgets.js';

export const budgetsRouter = Router();

const setBudgetSchema = z.object({
  scope: z.enum(['client_key', 'global']),
  scope_id: z.string().nullable().optional(),
  daily_limit_cents: z.number().int().min(0).nullable().optional(),
  weekly_limit_cents: z.number().int().min(0).nullable().optional(),
  monthly_limit_cents: z.number().int().min(0).nullable().optional(),
  weekly_reset_day: z.number().int().min(1).max(7).optional(),
}).refine(d => d.scope !== 'client_key' || d.scope_id, {
  message: 'scope_id is required when scope is client_key',
});

// List all budgets.
budgetsRouter.get('/', (_req: Request, res: Response) => {
  res.json(listBudgets());
});

// Set (upsert) a budget.
budgetsRouter.post('/', (req: Request, res: Response) => {
  const parsed = setBudgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid input' } });
    return;
  }
  setBudget(parsed.data.scope as BudgetScope, parsed.data.scope_id ?? null, {
    daily_limit_cents: parsed.data.daily_limit_cents,
    weekly_limit_cents: parsed.data.weekly_limit_cents,
    monthly_limit_cents: parsed.data.monthly_limit_cents,
    weekly_reset_day: parsed.data.weekly_reset_day,
  });
  res.status(201).json({ ok: true });
});

// Delete a budget.
budgetsRouter.delete('/', (req: Request, res: Response) => {
  const scope = req.query.scope as string;
  const scopeId = (req.query.scope_id as string) ?? null;
  if (!scope) {
    res.status(400).json({ error: { message: 'scope is required' } });
    return;
  }
  const ok = deleteBudget(scope as BudgetScope, scopeId);
  if (!ok) {
    res.status(404).json({ error: { message: 'Budget not found' } });
    return;
  }
  res.json({ ok: true });
});

// Reset used counters for a budget (admin action).
budgetsRouter.post('/reset', (req: Request, res: Response) => {
  const scope = req.query.scope as string;
  const scopeId = (req.query.scope_id as string) ?? null;
  if (!scope) {
    res.status(400).json({ error: { message: 'scope is required' } });
    return;
  }
  const ok = resetBudgetUsage(scope as BudgetScope, scopeId);
  if (!ok) {
    res.status(404).json({ error: { message: 'Budget not found' } });
    return;
  }
  res.json({ ok: true });
});
