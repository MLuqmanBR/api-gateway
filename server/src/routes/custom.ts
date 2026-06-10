import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

export const customRouter = Router();

// Built-in platform slugs are off-limits as custom slugs — the catalog
// already binds those names. Reject early to avoid silent shadowing.
const BUILTIN_SLUGS = new Set([
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
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
});

const updateProviderSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  baseUrl: z.string().url().optional(),
}).refine(d => d.displayName !== undefined || d.baseUrl !== undefined, {
  message: 'At least one of displayName or baseUrl must be provided',
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
});

const updateModelSchema = createModelSchema.partial().extend({
  enabled: z.boolean().optional(),
});

// Returns true if the model is owned by a custom provider (i.e. its
// platform slug is present in custom_providers). Built-in catalog rows
// return false and are not editable through /api/custom-* endpoints.
function isCustomModel(platform: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(platform);
}

// ── Providers ──────────────────────────────────────────────────────────

// List all custom providers with per-provider model + enabled-key counts so
// the UI doesn't have to cross-reference.
customRouter.get('/api/custom-providers', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM custom_providers ORDER BY created_at ASC').all() as Array<{
    id: number; slug: string; display_name: string; base_url: string; created_at: string;
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
    createdAt: r.created_at,
    modelCount: modelByPlatform.get(r.slug) ?? 0,
    keyCount: keysByPlatform.get(r.slug) ?? 0,
  })));
});

// Create a provider.
customRouter.post('/api/custom-providers', (req: Request, res: Response) => {
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { slug, displayName } = parsed.data;
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
    INSERT INTO custom_providers (slug, display_name, base_url) VALUES (?, ?, ?)
  `).run(slug, displayName.trim(), baseUrl);

  res.status(201).json({
    id: result.lastInsertRowid,
    slug,
    displayName: displayName.trim(),
    baseUrl,
    createdAt: new Date().toISOString(),
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
  const values: string[] = [];
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

  res.json({ success: true });
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
  const provider = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
  if (!provider) {
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
  const provider = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(slug);
  if (!provider) {
    res.status(404).json({ error: { message: `provider '${slug}' not found` } });
    return;
  }
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
         enabled, supports_vision, supports_tools, key_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      slug, modelId, displayName,
      d.intelligenceRank ?? MODEL_DEFAULTS.intelligenceRank,
      d.speedRank ?? MODEL_DEFAULTS.speedRank,
      d.sizeLabel ?? MODEL_DEFAULTS.sizeLabel,
      d.rpmLimit ?? MODEL_DEFAULTS.rpmLimit,
      d.rpdLimit ?? MODEL_DEFAULTS.rpdLimit,
      d.tpmLimit ?? MODEL_DEFAULTS.tpmLimit,
      d.tpdLimit ?? MODEL_DEFAULTS.tpdLimit,
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
  if (!isCustomModel(existing.platform)) {
    res.status(400).json({ error: { message: 'built-in catalog models are not editable through this endpoint' } });
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
  if (!isCustomModel(existing.platform)) {
    res.status(400).json({ error: { message: 'built-in catalog models cannot be deleted through this endpoint' } });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
  });
  tx();

  res.json({ success: true, id });
});