/**
 * F5: /api/cache — admin endpoints for the response cache.
 * Mount under /api (requireAuth blanket). Provides stats and purge.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getCacheStats, purgeCache } from '../services/cache.js';

export const cacheRouter = Router();

// Get cache stats (entries, hits, L1 size).
cacheRouter.get('/', (_req: Request, res: Response) => {
  res.json(getCacheStats());
});

// Purge all cached responses.
cacheRouter.post('/purge', (_req: Request, res: Response) => {
  const removed = purgeCache();
  res.json({ ok: true, removed });
});
