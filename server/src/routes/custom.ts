import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { clearRateLimitPenalty } from '../services/router.js';
import { clearPlatformCaches } from '../services/ratelimit.js';
import { hasProvider, buildProviderFor } from '../providers/index.js';

export const customRouter = Router();

// Built-in platform slugs are off-limits as custom slugs — the catalog
// already binds those names. Reject early to avoid silent shadowing.
const BUILTIN_SLUGS = new Set([
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode',
]);

// Slug format: lowercase letters, digits, dashes. 2-32 chars. Cannot start or
// end with a dash.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const createProviderSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must be 2-32 chars: lowercase letters, digits, dashes; cannot start or end with a dash'),
  displayName: z.string().min(1, 'displayName is required').max(80),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  maxParallelRequests: z.number().int().min(1).nullable().optional(),
});

const updateProviderSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  maxParallelRequests: z.number().int().min(1).nullable().optional(),
}).refine(d => d.displayName !== undefined || d.baseUrl !== undefined
  || d.rpmLimit !== undefined || d.rpdLimit !== undefined
  || d.tpmLimit !== undefined || d.tpdLimit !== undefined
  || d.maxParallelRequests !== undefined, {
  message: 'At least one field must be provided',
});

// Defaults for new custom models: moderate ranks, "Custom" size tier (sorts
// below named tiers in the intelligence preset), no rate limits, supports
// tools by default (the most common case for OpenAI-compatible endpoints).
const MODEL_DEFAULTS = {
  intelligenceRank: 50,
  speedRank: 50,
  sizeLabel: 'Custom',
  monthlyTokenBudget: '',
  rpmLimit: null,
  rpdLimit: null,
  tpmLimit: null,
  tpdLimit: null,
  supportsTools: true,
  supportsVision: false,
};

const createModelSchema = z.object({
  modelId: z.string().min(1, 'modelId is required').max(120),
  displayName: z.string().min(1, 'displayName is required').max(120),
  contextWindow: z.number().int().positive().nullable().optional(),
  intelligenceRank: z.number().int().min(1).max(100).optional(),
  speedRank: z.number().int().min(1).max(100).optional(),
  sizeLabel: z.string().max(40).optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  monthlyTokenBudget: z.string().max(40).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});

const updateModelSchema = createModelSchema.partial().extend({
  enabled: z.boolean().optional(),
});
// Returns true if the slug belongs to a known provider — either a built-in
// (registered in providers/index.ts) or a custom provider (present in
// custom_providers). Models on either kind of platform are user-editable
// through /api/custom-* endpoints as long as they're in the models table.
function isKnownProvider(slug: string): boolean {
  return hasProvider(slug as any) || !!getDb().prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
}

// ── Model auto-discovery ────────────────────────────────────────────────
// Fetches models from {baseUrl}/models (OpenAI-compatible format) and
// inserts them into the catalog with sensible defaults. Existing models
// (matched by platform + model_id) are skipped so re-runs are safe.

async function syncModelsFromProvider(baseUrl: string, slug: string): Promise<{ fetched: number; error?: string }> {
  // Skip auto-discovery in test environments — fake provider URLs won't respond.
  if (process.env.VITEST) return { fetched: 0 };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      console.log(`[Custom] ${slug}: /models returned ${res.status}, skipping auto-discovery`);
      return { fetched: 0 };
    }

    const body: any = await res.json();
    const models = body?.data;
    if (!Array.isArray(models) || models.length === 0) {
      console.log(`[Custom] ${slug}: no models in /models response`);
      return { fetched: 0 };
    }

    const db = getDb();
    let added = 0;
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number }).m;

    const insertModel = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, max_output_tokens, key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
    `);
    const insertFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');

    const tx = db.transaction(() => {
      for (const m of models) {
        const modelId = typeof m.id === 'string' ? m.id.trim() : '';
        if (!modelId) continue;

        // Skip if already registered
        const exists = db.prepare('SELECT 1 FROM models WHERE platform = ? AND model_id = ?').get(slug, modelId);
        if (exists) continue;

        // Use the model id as display name (user can rename later).
        // Defaults match MODEL_DEFAULTS: middle ranks, no rate limits,
        // tools=true, vision=false, unknown context window.
        const displayName = modelId;
        const result = insertModel.run(
          slug, modelId, displayName,
          MODEL_DEFAULTS.intelligenceRank, MODEL_DEFAULTS.speedRank, MODEL_DEFAULTS.sizeLabel,
          MODEL_DEFAULTS.rpmLimit, MODEL_DEFAULTS.rpdLimit, MODEL_DEFAULTS.tpmLimit, MODEL_DEFAULTS.tpdLimit,
          MODEL_DEFAULTS.monthlyTokenBudget, null, // context_window = unknown
          MODEL_DEFAULTS.supportsVision ? 1 : 0, MODEL_DEFAULTS.supportsTools ? 1 : 0,
        );
        const modelDbId = Number(result.lastInsertRowid);
        insertFb.run(modelDbId, maxPriority + added + 1);
        added++;
      }
    });
    tx();

    console.log(`[Custom] ${slug}: discovered ${added} models (${models.length} total, skipped ${models.length - added} existing)`);
    return { fetched: added };
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    console.log(`[Custom] ${slug}: model sync failed: ${msg}`);
    return { fetched: 0, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Providers ──────────────────────────────────────────────────────────

// List all custom providers with per-provider model + enabled-key counts so
// the UI doesn't have to cross-reference.
customRouter.get('/api/custom-providers', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM custom_providers ORDER BY created_at ASC').all() as Array<{
    id: number; slug: string; display_name: string; base_url: string;
    rpm_limit: number | null; rpd_limit: number | null;
    tpm_limit: number | null; tpd_limit: number | null;
    max_parallel_requests: number | null;
    created_at: string;
  }>;
  const modelCounts = db.prepare(`
    SELECT platform, COUNT(*) AS n FROM models GROUP BY platform
  `).all() as Array<{ platform: string; n: number }>;
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 GROUP BY platform
  `).all() as Array<{ platform: string; n: number }>;
  const modelByPlatform = new Map(modelCounts.map(r => [r.platform, r.n]));
  const keysByPlatform = new Map(keyCounts.map(r => [r.platform, r.n]));

  res.json(rows.map(r => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    baseUrl: r.base_url,
    rpmLimit: r.rpm_limit,
    rpdLimit: r.rpd_limit,
    tpmLimit: r.tpm_limit,
    tpdLimit: r.tpd_limit,
    maxParallelRequests: r.max_parallel_requests,
    createdAt: r.created_at,
    modelCount: modelByPlatform.get(r.slug) ?? 0,
    keyCount: keysByPlatform.get(r.slug) ?? 0,
  })));
});

// Create a provider. After inserting, auto-discovers models from {baseUrl}/models.
customRouter.post('/api/custom-providers', async (req: Request, res: Response) => {
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { slug, displayName, rpmLimit, rpdLimit, tpmLimit, tpdLimit, maxParallelRequests } = parsed.data;
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');

  if (BUILTIN_SLUGS.has(slug)) {
    res.status(400).json({ error: { message: `slug '${slug}' is reserved by a built-in platform` } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
  if (existing) {
    res.status(409).json({ error: { message: `provider with slug '${slug}' already exists` } });
    return;
  }

  const result = db.prepare(`
    INSERT INTO custom_providers (slug, display_name, base_url, rpm_limit, rpd_limit, tpm_limit, tpd_limit, max_parallel_requests)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, displayName.trim(), baseUrl, rpmLimit ?? null, rpdLimit ?? null, tpmLimit ?? null, tpdLimit ?? null, maxParallelRequests ?? null);

  // Auto-discover models from the provider's /models endpoint.
  const sync = await syncModelsFromProvider(baseUrl, slug);

  res.status(201).json({
    id: result.lastInsertRowid,
    slug,
    displayName: displayName.trim(),
    baseUrl,
    rpmLimit: rpmLimit ?? null,
    rpdLimit: rpdLimit ?? null,
    tpmLimit: tpmLimit ?? null,
    tpdLimit: tpdLimit ?? null,
    maxParallelRequests: maxParallelRequests ?? null,
    createdAt: new Date().toISOString(),
    modelsDiscovered: sync.fetched,
    ...(sync.error ? { syncError: sync.error } : {}),
  });
});

// Edit display name or base URL.
customRouter.patch('/api/custom-providers/:slug', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const parsed = updateProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
  if (!existing) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (parsed.data.displayName !== undefined) {
    updates.push('display_name = ?');
    values.push(parsed.data.displayName.trim());
  }
  if (parsed.data.baseUrl !== undefined) {
    const trimmed = parsed.data.baseUrl.trim().replace(/\/+$/, '');
    updates.push('base_url = ?');
    values.push(trimmed);
    // Keep api_keys.base_url denormalized in sync so older code paths
    // (health checks) see the new endpoint immediately.
    db.prepare('UPDATE api_keys SET base_url = ? WHERE platform = ?').run(trimmed, slug);
  }
  if (parsed.data.rpmLimit !== undefined) {
    updates.push('rpm_limit = ?');
    values.push(parsed.data.rpmLimit);
  }
  if (parsed.data.rpdLimit !== undefined) {
    updates.push('rpd_limit = ?');
    values.push(parsed.data.rpdLimit);
  }
  if (parsed.data.tpmLimit !== undefined) {
    updates.push('tpm_limit = ?');
    values.push(parsed.data.tpmLimit);
  }
  if (parsed.data.tpdLimit !== undefined) {
    updates.push('tpd_limit = ?');
    values.push(parsed.data.tpdLimit);
  }
  if (parsed.data.maxParallelRequests !== undefined) {
    updates.push('max_parallel_requests = ?');
    values.push(parsed.data.maxParallelRequests);
  }
  values.push(slug);
  db.prepare(`UPDATE custom_providers SET ${updates.join(', ')} WHERE slug = ?`).run(...values);

  res.json({ success: true, slug });
});

// Delete a provider. Cascades: drops every model on the provider and every
// fallback_config row pointing at those models, plus every api_key on the
// platform. Built-in catalog rows on other platforms are untouched.
customRouter.delete('/api/custom-providers/:slug', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
  if (!existing) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)').run(slug);
    db.prepare('DELETE FROM models WHERE platform = ?').run(slug);
    db.prepare('DELETE FROM api_keys WHERE platform = ?').run(slug);
    db.prepare('DELETE FROM custom_providers WHERE slug = ?').run(slug);
  });
  tx();

  clearPlatformCaches(slug);
  res.json({ success: true });
});

// Trigger model auto-discovery for an existing provider.
customRouter.post('/api/custom-providers/:slug/sync-models', async (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  // Resolve base URL: custom providers have it in the DB; built-in providers
  // expose it via BaseProvider.baseUrl.
  const customRow = getDb().prepare('SELECT base_url FROM custom_providers WHERE slug = ?').get(slug) as { base_url: string } | undefined;
  let baseUrl: string | undefined;
  if (customRow) {
    baseUrl = customRow.base_url;
  } else if (hasProvider(slug as any)) {
    const provider = buildProviderFor(slug);
    baseUrl = provider?.baseUrl;
  }
  if (!baseUrl) {
    res.status(404).json({ error: { message: `provider '${slug}' not found or does not support model discovery` } });
    return;
  }

  const result = await syncModelsFromProvider(baseUrl, slug);

  res.json({ success: true, slug, fetched: result.fetched, error: result.error });
});

// ── Models ─────────────────────────────────────────────────────────────

// List all models for a custom provider. Same shape as /api/models entries
// (so the dashboard can render them in the same list as built-in models).
customRouter.get('/api/custom-providers/:slug/models', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const db = getDb();
  if (!isKnownProvider(slug)) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled AS fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.platform = ?
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all(slug) as Array<any>;

  res.json(models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
  })));
});

// Add a model to a custom provider. Creates the model row and appends it
// to the fallback chain at the lowest priority (so it routes after the
// existing chain until the user reorders in the Fallback page).
customRouter.post('/api/custom-providers/:slug/models', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  if (!SLUG_RE.test(slug)) {
    res.status(400).json({ error: { message: 'invalid slug' } });
    return;
  }

  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  if (!isKnownProvider(slug)) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }

  const provRow = db.prepare('SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM custom_providers WHERE slug = ?').get(slug) as { rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null } | undefined;
  // Built-in providers return null provRow — use MODEL_DEFAULTS for limits.
  const d = parsed.data;
  const modelId = d.modelId.trim();
  const displayName = d.displayName.trim();
  // UNIQUE(platform, model_id) protects against re-registering the same id.
  const dup = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(slug, modelId);
  if (dup) {
    res.status(409).json({ error: { message: `model '${modelId}' already exists on provider '${slug}'` } });
    return;
  }
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, max_output_tokens, key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
    `).run(
      slug, modelId, displayName,
      d.intelligenceRank ?? MODEL_DEFAULTS.intelligenceRank,
      d.speedRank ?? MODEL_DEFAULTS.speedRank,
      d.sizeLabel ?? MODEL_DEFAULTS.sizeLabel,
      d.rpmLimit ?? provRow?.rpm_limit ?? MODEL_DEFAULTS.rpmLimit,
      d.rpdLimit ?? provRow?.rpd_limit ?? MODEL_DEFAULTS.rpdLimit,
      d.tpmLimit ?? provRow?.tpm_limit ?? MODEL_DEFAULTS.tpmLimit,
      d.tpdLimit ?? provRow?.tpd_limit ?? MODEL_DEFAULTS.tpdLimit,
      d.monthlyTokenBudget ?? MODEL_DEFAULTS.monthlyTokenBudget,
      d.contextWindow ?? null,
      d.supportsVision ?? MODEL_DEFAULTS.supportsVision ? 1 : 0,
      d.supportsTools ?? MODEL_DEFAULTS.supportsTools ? 1 : 0,
    );
    const modelDbId = Number(result.lastInsertRowid);
    // Append to the fallback chain if not already present.
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
    if (!inChain) {
      const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, max.m + 1);
    }
    return modelDbId;
  });
  const modelDbId = tx();
  res.status(201).json({
    success: true,
    id: modelDbId,
    platform: slug,
    modelId,
    displayName,
  });
});

// Edit any subset of a custom model. Built-in catalog rows return 400 — they
// have a separate migration path (server migrations) and should not be
// mutated through this endpoint.
customRouter.patch('/api/custom-models/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'invalid model id' } });
    return;
  }

  const parsed = updateModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT platform FROM models WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: { message: 'model not found' } });
    return;
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  const d = parsed.data;
  if (d.displayName !== undefined) { updates.push('display_name = ?'); values.push(d.displayName.trim()); }
  if (d.contextWindow !== undefined) { updates.push('context_window = ?'); values.push(d.contextWindow); }
  if (d.intelligenceRank !== undefined) { updates.push('intelligence_rank = ?'); values.push(d.intelligenceRank); }
  if (d.speedRank !== undefined) { updates.push('speed_rank = ?'); values.push(d.speedRank); }
  if (d.sizeLabel !== undefined) { updates.push('size_label = ?'); values.push(d.sizeLabel); }
  if (d.supportsTools !== undefined) { updates.push('supports_tools = ?'); values.push(d.supportsTools ? 1 : 0); }
  if (d.supportsVision !== undefined) { updates.push('supports_vision = ?'); values.push(d.supportsVision ? 1 : 0); }
  if (d.monthlyTokenBudget !== undefined) { updates.push('monthly_token_budget = ?'); values.push(d.monthlyTokenBudget); }
  if (d.rpmLimit !== undefined) { updates.push('rpm_limit = ?'); values.push(d.rpmLimit); }
  if (d.rpdLimit !== undefined) { updates.push('rpd_limit = ?'); values.push(d.rpdLimit); }
  if (d.tpmLimit !== undefined) { updates.push('tpm_limit = ?'); values.push(d.tpmLimit); }
  if (d.tpdLimit !== undefined) { updates.push('tpd_limit = ?'); values.push(d.tpdLimit); }
  if (d.maxOutputTokens !== undefined) { updates.push('max_output_tokens = ?'); values.push(d.maxOutputTokens); }
  if (d.enabled !== undefined) { updates.push('enabled = ?'); values.push(d.enabled ? 1 : 0); }

  if (updates.length === 0) {
    res.json({ success: true, id });
    return;
  }

  values.push(id);
  db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true, id });
});

// Remove a single custom model from the catalog and the fallback chain.
// The provider row stays — only the model is deleted. Use the provider
// DELETE to drop the whole provider.
customRouter.delete('/api/custom-models/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'invalid model id' } });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT platform FROM models WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: { message: 'model not found' } });
    return;
  }
  // Models on any known provider can be deleted here. Built-in catalog rows
  // (seeded by migrations) will simply be re-created on next server start
  // if they're still in the migration chain, so deletion is safe.

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
  });
  tx();

  clearRateLimitPenalty(id);
  res.json({ success: true, id });
});