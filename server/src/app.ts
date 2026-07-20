import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { budgetsRouter } from './routes/budgets.js';
import { platformsRouter } from './routes/platforms.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { responsesRouter } from './routes/responses.js';
import { fallbackRouter } from './routes/fallback.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { authRouter } from './routes/auth.js';
import { eventsRouter, eventsStreamHandler } from './routes/events.js';
import { customRouter } from './routes/custom.js';
import { configRouter } from './routes/config.js';
import { requireAuth } from './middleware/requireAuth.js';
import { createProxyRateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DASHBOARD_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

function getAllowedCorsOrigins() {
  const configuredOrigins = (process.env.DASHBOARD_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_DASHBOARD_ORIGINS, ...configuredOrigins]);
}

export function createApp() {
  const app = express();
  // Honor `X-Forwarded-For` only when the operator opts in. Without this, the
  // LAN auto-grant in requireAuth falls back to the TCP peer IP, which is the
  // only safe default when the server is bound directly. `TRUST_PROXY=1` is
  // a single-hop trust — the upstream must be a reverse proxy you control.
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }
  const allowedCorsOrigins = getAllowedCorsOrigins();

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
  }));
  // 10mb: code agents (OpenCode, AionUI, Qwen Code) ship very large system
  // prompts + tool schemas + repo context; 1mb cut their sessions off
  // mid-conversation with an opaque 413. (#200)
  app.use(express.json({ limit: '10mb' }));

  // Dashboard auth (#35): /api/auth/{status,setup,login} bootstrap without a
  // session; everything else under /api/* requires a logged-in dashboard user.
  // The /v1 proxy keeps its own unified-API-key auth and is NOT gated here.
  app.use('/api/auth', authRouter);

  // Health check — intentionally above the /api blanket below so it
  // stays public (load balancers and monitoring poll it).
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // SSE stream — intentionally above the /api requireAuth blanket (#43).
  // EventSource can't send an Authorization header, so a remote operator
  // authenticates with a short-lived single-use `?ticket=` (minted from the
  // authed /api/events/ticket route below); the handler validates+consumes it
  // when the caller isn't LAN-trusted. LAN-trusted callers stream unchanged.
  app.get('/api/events', eventsStreamHandler);

  // Default-deny: every /api/* route is gated by requireAuth unless
  // deliberately mounted above this blanket.  Existing per-router
  // requireAuth args stay as harmless redundancy.
  app.use('/api', requireAuth);

  // API routes — all admin endpoints sit behind the blanket /api requireAuth
  // above; no per-router mount is needed.
  app.use('/api/keys', keysRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/platforms', platformsRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/embeddings', embeddingsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  // Configuration export/import (versioned JSON envelope). Dashboard-
  // only — there's no operational reason a /v1 caller needs this.
  app.use('/api/config', configRouter);
  // Custom providers + their models — gated by the /api blanket above.
  app.use(customRouter);
  app.use('/v1', createProxyRateLimiter());
  app.use('/v1', proxyRouter);
  // OpenAI Responses API shim (Codex CLI requires wire_api="responses"; see #96)
  app.use('/v1', responsesRouter);
  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler). CLIENT_DIST lets
  // embedders relocate the built dashboard (e.g. the desktop app ships it in
  // extraResources, where the __dirname-relative path can't reach).
  const clientDist = process.env.CLIENT_DIST
    ? path.resolve(process.env.CLIENT_DIST)
    : path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
