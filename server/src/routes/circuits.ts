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
    // L11: strict integer guard. parseInt('12abc') === 12 and parseInt('abc')
    // === NaN both used to reach resetCircuit, where a NaN keyId matched
    // nothing — a silent no-op reset that still reported { ok: true }.
    const keyNum = Number(keyId);
    if (String(keyId).trim() === '' || !Number.isInteger(keyNum)) {
      res.status(400).json({ error: { message: 'keyId must be an integer' } });
      return;
    }
    resetCircuit(platform as string, model as string, keyNum);
  } else {
    resetAllCircuits();
  }
  res.json({ ok: true });
});
