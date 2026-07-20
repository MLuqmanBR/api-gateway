/**
 * F7: GET /metrics — Prometheus scrape endpoint.
 *
 * Auth: METRICS_AUTH_TOKEN env bearer ONLY (fail-closed 401 if unset).
 * No LAN auto-trust. Mounted BEFORE the /api requireAuth blanket so
 * Prometheus can scrape without dashboard auth.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getMetricsText, isMetricsAuthEnabled, verifyMetricsToken } from '../services/metrics.js';

export const metricsRouter = Router();

metricsRouter.get('/metrics', async (req: Request, res: Response) => {
  // Fail-closed: if METRICS_AUTH_TOKEN is not set, return 401.
  if (!isMetricsAuthEnabled()) {
    res.status(401).json({ error: { message: 'METRICS_AUTH_TOKEN not configured' } });
    return;
  }

  // Accept bearer token via Authorization header or ?token= query param
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  const queryToken = req.query.token as string | undefined;
  const token = bearer ?? queryToken;

  if (!verifyMetricsToken(token)) {
    res.status(401).json({ error: { message: 'Invalid metrics token' } });
    return;
  }

  res.setHeader('Content-Type', registerContentType());
  res.send(await getMetricsText());
});

function registerContentType(): string {
  return 'text/plain; version=0.0.4; charset=utf-8';
}
