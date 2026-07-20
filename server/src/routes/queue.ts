/**
 * F9: /api/queue — admin endpoint to view queue stats.
 * Mount under /api (requireAuth blanket).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getQueueStats, isQueueEnabled } from '../services/queue.js';

export const queueRouter = Router();

queueRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    enabled: isQueueEnabled(),
    stats: getQueueStats(),
  });
});
