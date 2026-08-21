/**
 * F8: /api/webhooks — admin CRUD for webhook endpoints.
 * Mount under /api (requireAuth blanket).
 * Uses query params for id-based operations (avoids /:id route collision
 * with keys router in the route-map test).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listWebhooks, createWebhook, deleteWebhook, toggleWebhook } from '../services/webhooks.js';
import { getSetting } from '../db/index.js';
import { assertPublicHttpUrl } from '../lib/url-guard.js';

export const webhooksRouter = Router();

const createWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(1),
  events_filter: z.string().default('*'),
});

webhooksRouter.get('/', (_req: Request, res: Response) => {
  res.json(listWebhooks());
});

webhooksRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid input' } });
    return;
  }
  try {
    // H10: resolve-and-check SSRF guard (not just literal host matching) —
    // names that resolve privately, mapped-IPv6, and hex/octal IP spellings
    // are rejected too. `allow_internal_webhooks` (or the
    // WEBHOOK_ALLOW_PRIVATE_HOSTS env) stays as the explicit operator opt-in
    // for internal receivers.
    if (getSetting('allow_internal_webhooks') !== 'true' && process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS !== '1') {
      await assertPublicHttpUrl(parsed.data.url);
    }
    const webhook = createWebhook(parsed.data);
    res.status(201).json(webhook);
  } catch (e: any) {
    res.status(400).json({ error: { message: e.message } });
  }
});

webhooksRouter.delete('/', (req: Request, res: Response) => {
  const id = parseInt(req.query.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'id query param required' } });
    return;
  }
  if (!deleteWebhook(id)) {
    res.status(404).json({ error: { message: 'Webhook not found' } });
    return;
  }
  res.json({ ok: true });
});

webhooksRouter.patch('/', (req: Request, res: Response) => {
  const id = parseInt(req.query.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'id query param required' } });
    return;
  }
  const enabled = req.body.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be boolean' } });
    return;
  }
  if (!toggleWebhook(id, enabled)) {
    res.status(404).json({ error: { message: 'Webhook not found' } });
    return;
  }
  res.json({ ok: true });
});
