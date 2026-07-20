/**
 * F10: /api/circuits — admin endpoint to view circuit breaker states.
 * Mount under /api (requireAuth blanket).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAllCircuits, resetCircuit, resetAllCircuits } from '../services/circuit-breaker.js';

export const circuitsRouter = Router();

circuitsRouter.get('/', (_req: Request, res: Response) => {
  res.json(getAllCircuits());
});

circuitsRouter.delete('/', (req: Request, res: Response) => {
  const { platform, model, keyId } = req.query;
  if (platform && model && keyId) {
    resetCircuit(platform as string, model as string, parseInt(keyId as string, 10));
  } else {
    resetAllCircuits();
  }
  res.json({ ok: true });
});
