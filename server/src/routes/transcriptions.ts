import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting } from '../db/index.js';
import { listTranscriptionModels, getDefaultFamily, type TranscriptionModelRow } from '../services/transcriptions.js';

export const transcriptionsRouter = Router();

// Families with their provider chains, for the dashboard Transcription tab.
transcriptionsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare(
      "SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform",
    ).all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );

  const byFamily = new Map<string, TranscriptionModelRow[]>();
  for (const row of listTranscriptionModels()) {
    const list = byFamily.get(row.family) ?? [];
    list.push(row);
    byFamily.set(row.family, list);
  }

  const defaultFamily = getDefaultFamily();
  res.json({
    defaultFamily,
    families: [...byFamily.entries()].map(([family, rows]) => ({
      family,
      maxFileMb: rows[0].max_file_mb,
      supportsTranslations: rows[0].supports_translations === 1,
      isDefault: family === defaultFamily,
      providers: rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        priority: r.priority,
        enabled: r.enabled === 1,
        quotaLabel: r.quota_label,
        keyCount: keyCounts.get(r.platform) ?? 0,
        pricePerHourUsd: r.price_per_hour_usd,
      })),
    })),
  });
});

const updateSchema = z.object({
  defaultFamily: z.string().optional(),
  providers: z.array(z.object({
    id: z.number(),
    priority: z.number(),
    enabled: z.boolean(),
  })).optional(),
});

// Edit-only by design: priority/enabled per row + the default family. New
// models come from config import or a future migration seed — never this
// endpoint — and price_per_hour_usd is seed-owned (the dashboard PUT has no
// path to drift verified pricing).
transcriptionsRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }
  const db = getDb();

  if (parsed.data.defaultFamily) {
    const exists = db.prepare('SELECT 1 FROM transcription_models WHERE family = ?').get(parsed.data.defaultFamily);
    if (!exists) {
      res.status(400).json({ error: { message: `Unknown family '${parsed.data.defaultFamily}'` } });
      return;
    }
    setSetting('transcriptions_default_family', parsed.data.defaultFamily);
  }

  if (parsed.data.providers) {
    const update = db.prepare('UPDATE transcription_models SET priority = ?, enabled = ? WHERE id = ?');
    const apply = db.transaction((rows: { id: number; priority: number; enabled: boolean }[]) => {
      for (const r of rows) update.run(r.priority, r.enabled ? 1 : 0, r.id);
    });
    apply(parsed.data.providers);
  }

  res.json({ success: true });
});

// Per-family usage: requests today and audio seconds this calendar month,
// from the tagged request log. Audio is billed by duration, so the month
// rollup is SUM(audio_seconds) — surfaced as minutes.
transcriptionsRouter.get('/usage', (_req: Request, res: Response) => {
  const db = getDb();
  const usage = db.prepare(`
    SELECT tm.family,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) AS requests_today,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of month') THEN r.audio_seconds ELSE 0 END), 0) AS audio_seconds_month
    FROM transcription_models tm
    LEFT JOIN requests r
      ON r.request_type = 'transcription'
     AND r.status = 'success'
     AND r.platform = tm.platform
     AND r.model_id = tm.model_id
     AND r.created_at >= datetime('now', 'start of month')
    GROUP BY tm.family
  `).all() as { family: string; requests_today: number; audio_seconds_month: number }[];

  res.json({
    families: usage.map(u => ({
      family: u.family,
      requestsToday: u.requests_today,
      audioMinutesMonth: u.audio_seconds_month / 60,
    })),
  });
});
