import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const platformsRouter = Router();

// Active built-in providers — must match providers/index.ts registrations +
// shared/types.ts Platform. Custom providers are NOT in this list: they are
// created via POST /api/custom-providers and have their own base URL.
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu',
  'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface',
  'opencode', 'ovh', 'commandcode',
] as const;

// Per-platform settings for built-in providers. Slimmer than the
// custom_providers update schema — built-ins have immutable slug / base_url /
// api_format / max_parallel, so only the editable fields remain.
const platformsSettingsPatchSchema = z.object({
  rpmLimit: z.number().int().min(0).nullable().optional(),
  rpdLimit: z.number().int().min(0).nullable().optional(),
  tpmLimit: z.number().int().min(0).nullable().optional(),
  tpdLimit: z.number().int().min(0).nullable().optional(),
  stickySessionsEnabled: z.boolean().optional(),
}).refine(d =>
  d.rpmLimit !== undefined || d.rpdLimit !== undefined ||
  d.tpmLimit !== undefined || d.tpdLimit !== undefined ||
  d.stickySessionsEnabled !== undefined,
  { message: 'At least one of rpmLimit, rpdLimit, tpmLimit, tpdLimit, stickySessionsEnabled must be provided' },
);

// GET /api/platforms/:platform/settings — returns the editable fields.
// 404 if the slug isn't a built-in (customs use /api/custom-providers/:slug).
platformsRouter.get('/:platform/settings', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(404).json({ error: { message: `Unknown built-in platform '${platform}'` } });
    return;
  }
  const db = getDb();
  const row = db.prepare(
    `SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit, sticky_sessions_enabled
       FROM built_in_provider_settings WHERE platform = ?`,
  ).get(platform) as
    | { rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null; sticky_sessions_enabled: number }
    | undefined;
  res.json({
    platform,
    rpmLimit: row?.rpm_limit ?? null,
    rpdLimit: row?.rpd_limit ?? null,
    tpmLimit: row?.tpm_limit ?? null,
    tpdLimit: row?.tpd_limit ?? null,
    stickySessionsEnabled: row?.sticky_sessions_enabled === 1,
  });
});

// PATCH /api/platforms/:platform/settings — update one or more editable fields.
// 404 if the slug isn't a built-in. Empty body rejected.
platformsRouter.patch('/:platform/settings', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(404).json({ error: { message: `Unknown built-in platform '${platform}'` } });
    return;
  }
  const parsed = platformsSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (parsed.data.rpmLimit !== undefined) { updates.push('rpm_limit = ?'); values.push(parsed.data.rpmLimit); }
  if (parsed.data.rpdLimit !== undefined) { updates.push('rpd_limit = ?'); values.push(parsed.data.rpdLimit); }
  if (parsed.data.tpmLimit !== undefined) { updates.push('tpm_limit = ?'); values.push(parsed.data.tpmLimit); }
  if (parsed.data.tpdLimit !== undefined) { updates.push('tpd_limit = ?'); values.push(parsed.data.tpdLimit); }
  if (parsed.data.stickySessionsEnabled !== undefined) {
    updates.push('sticky_sessions_enabled = ?');
    values.push(parsed.data.stickySessionsEnabled ? 1 : 0);
  }
  if (updates.length === 0) {
    res.status(400).json({ error: { message: 'No fields to update' } });
    return;
  }
  updates.push("updated_at = datetime('now')");
  values.push(platform);
  const db = getDb();
  db.prepare(
    `UPDATE built_in_provider_settings SET ${updates.join(', ')} WHERE platform = ?`,
  ).run(...values);
  const row = db.prepare(
    `SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit, sticky_sessions_enabled
       FROM built_in_provider_settings WHERE platform = ?`,
  ).get(platform) as
    | { rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null; sticky_sessions_enabled: number }
    | undefined;
  res.json({
    platform,
    rpmLimit: row?.rpm_limit ?? null,
    rpdLimit: row?.rpd_limit ?? null,
    tpmLimit: row?.tpm_limit ?? null,
    tpdLimit: row?.tpd_limit ?? null,
    stickySessionsEnabled: row?.sticky_sessions_enabled === 1,
  });
});