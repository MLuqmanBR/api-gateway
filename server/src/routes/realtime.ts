import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { listRealtimeModels, resolveRealtimeUrl } from '../services/realtime.js';
import { buildProviderFor } from '../providers/index.js';

export const realtimeRouter = Router();

/**
 * GET /api/realtime — the realtime catalog for the dashboard.
 *
 * `endpoint` and `keyCount` are computed from the live provider registry and
 * key table rather than stored, so the dashboard always shows whether a row
 * can actually connect right now. A row with no endpoint or no key renders a
 * badge instead of failing at connection time with an opaque websocket error.
 */
realtimeRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare(
      "SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform",
    ).all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );

  res.json({
    models: listRealtimeModels().map(row => ({
      id: row.id,
      platform: row.platform,
      modelId: row.model_id,
      displayName: row.display_name,
      priority: row.priority,
      enabled: row.enabled === 1,
      keyCount: keyCounts.get(row.platform) ?? 0,
      endpoint: resolveRealtimeUrl(row.platform, row.model_id),
      hasProvider: buildProviderFor(row.platform) !== undefined,
    })),
  });
});

const createSchema = z.object({
  platform: z.string().min(1).max(80),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
});

/**
 * POST /api/realtime — add a realtime model.
 *
 * Unlike transcriptions (edit-only, because the seed owns verified endpoints),
 * realtime rows MUST be creatable: which realtime models an account can reach
 * depends on its own provider access, so no seed can know them. The endpoint
 * is still derived from the provider registry, never supplied by the client.
 */
realtimeRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { platform, modelId, displayName } = parsed.data;

  if (!buildProviderFor(platform)) {
    res.status(400).json({
      error: { message: `unknown provider '${platform}' — add it as a custom provider first` },
    });
    return;
  }

  const db = getDb();
  const dup = db.prepare(
    'SELECT id FROM realtime_models WHERE platform = ? AND model_id = ?',
  ).get(platform, modelId);
  if (dup) {
    res.status(409).json({ error: { message: `realtime model '${platform}/${modelId}' already exists` } });
    return;
  }

  const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM realtime_models').get() as { m: number };
  const result = db.prepare(
    'INSERT INTO realtime_models (platform, model_id, display_name, priority, enabled) VALUES (?, ?, ?, ?, 1)',
  ).run(platform, modelId, displayName ?? modelId, max.m + 1);

  res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
});

const updateSchema = z.object({
  models: z.array(z.object({
    id: z.number(),
    priority: z.number().optional(),
    enabled: z.boolean().optional(),
  })).min(1),
});

/** PUT /api/realtime — reorder / enable / disable rows. */
realtimeRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const db = getDb();
  const tx = db.transaction(() => {
    for (const m of parsed.data.models) {
      const updates: string[] = [];
      const values: number[] = [];
      if (m.priority !== undefined) { updates.push('priority = ?'); values.push(m.priority); }
      if (m.enabled !== undefined) { updates.push('enabled = ?'); values.push(m.enabled ? 1 : 0); }
      if (updates.length === 0) continue;
      values.push(m.id);
      db.prepare(`UPDATE realtime_models SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  });
  tx();
  res.json({ success: true });
});

/** DELETE /api/realtime/:id — remove a row. */
realtimeRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'invalid id' } });
    return;
  }
  const result = getDb().prepare('DELETE FROM realtime_models WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'realtime model not found' } });
    return;
  }
  res.json({ success: true });
});
