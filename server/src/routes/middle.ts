/**
 * Middle-layer admin API — Row B2-7.
 *
 * Dashboard CRUD for the privacy layer's config, known-secrets store, and
 * interceptor stats. All endpoints sit behind the /api requireAuth blanket.
 *
 * Route shape follows the query-param id pattern (DELETE/PATCH ?id=N) to
 * avoid colliding with keysRouter's /:id routes in the route-map test (see
 * the Express 5 mount-path limitation documented in F8 webhooks).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getSetting, setSetting } from '../db/index.js';
import { clearMiddleConfigCache, type MiddleConfig } from '../middle/index.js';
import { listSecrets, addSecret, removeSecret, setEnabled } from '../middle/redaction/store.js';
import { getInterceptorFailures } from '../middle/redaction/interceptor.js';

export const middleRouter = Router();

// ── Config ─────────────────────────────────────────────────────────────────

const CONFIG_KEYS = [
  'middle_redaction_enabled',
  'middle_compression_enabled',
  'middle_compression_min_tokens',
  'middle_compression_protect_recent',
  'middle_compression_smart_crusher',
  'middle_compression_toon',
  'middle_compression_emit_sentinel',
  'middle_compression_smart_crusher_lossless_only',
  'middle_compression_min_savings_ratio',
  'middle_interceptor_model',
  'middle_interceptor_timeout_ms',
  'middle_detection_targets',
  'middle_interceptor_inbound_enabled',
] as const;

const DEFAULTS: Record<string, string> = {
  middle_redaction_enabled: '0',
  middle_compression_enabled: '0',
  middle_compression_min_tokens: '250',
  middle_compression_protect_recent: '4',
  middle_compression_smart_crusher: '0',
  middle_compression_toon: '0',
  middle_compression_emit_sentinel: '1',
  middle_compression_smart_crusher_lossless_only: '1',
  middle_compression_min_savings_ratio: '0.15',
  middle_interceptor_model: '',
  middle_interceptor_timeout_ms: '4000',
  middle_detection_targets: '["api_key","email","phone","person","address"]',
  middle_interceptor_inbound_enabled: '0',
};

middleRouter.get('/config', (_req: Request, res: Response) => {
  const config: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    config[key] = getSetting(key) ?? DEFAULTS[key];
  }
  res.json(config);
});

const updateConfigSchema = z.object({
  middle_redaction_enabled: z.string().optional(),
  middle_compression_enabled: z.string().optional(),
  middle_compression_min_tokens: z.string().optional(),
  middle_compression_protect_recent: z.string().optional(),
  middle_compression_smart_crusher: z.string().optional(),
  middle_compression_toon: z.string().optional(),
  middle_compression_emit_sentinel: z.string().optional(),
  middle_compression_smart_crusher_lossless_only: z.string().optional(),
  middle_compression_min_savings_ratio: z.string().optional(),
  middle_interceptor_model: z.string().optional(),
  middle_interceptor_timeout_ms: z.string().optional(),
  middle_detection_targets: z.string().optional(),
  middle_interceptor_inbound_enabled: z.string().optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one config key must be provided',
});

middleRouter.put('/config', (req: Request, res: Response) => {
  const parsed = updateConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid config', type: 'invalid_request_error' } });
    return;
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      setSetting(key, value);
    }
  }
  clearMiddleConfigCache();
  res.json({ ok: true });
});

// ── Secrets ─────────────────────────────────────────────────────────────────

middleRouter.get('/secrets', (_req: Request, res: Response) => {
  res.json(listSecrets());
});

const addSecretSchema = z.object({
  value: z.string().min(1, 'value is required'),
  kind: z.string().min(1, 'kind is required'),
  label: z.string().optional(),
});

middleRouter.post('/secrets', (req: Request, res: Response) => {
  const parsed = addSecretSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid secret', type: 'invalid_request_error' } });
    return;
  }
  const id = addSecret(parsed.data.value, parsed.data.kind, 'manual', parsed.data.label);
  res.json({ id, ok: true });
});

middleRouter.delete('/secrets', (req: Request, res: Response) => {
  const id = req.query.id as string | undefined;
  if (!id) {
    res.status(400).json({ error: { message: 'id query parameter is required', type: 'invalid_request_error' } });
    return;
  }
  removeSecret(id);
  res.json({ ok: true });
});

const patchSecretSchema = z.object({
  enabled: z.boolean().optional(),
}).refine(data => data.enabled !== undefined, {
  message: 'enabled must be provided',
});

middleRouter.patch('/secrets', (req: Request, res: Response) => {
  const id = req.query.id as string | undefined;
  if (!id) {
    res.status(400).json({ error: { message: 'id query parameter is required', type: 'invalid_request_error' } });
    return;
  }
  const parsed = patchSecretSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid patch', type: 'invalid_request_error' } });
    return;
  }
  setEnabled(id, parsed.data.enabled!);
  res.json({ ok: true });
});

// ── Stats ───────────────────────────────────────────────────────────────────

middleRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({
    interceptor_failures: getInterceptorFailures(),
    active_secrets: listSecrets().filter(s => s.enabled).length,
  });
});
