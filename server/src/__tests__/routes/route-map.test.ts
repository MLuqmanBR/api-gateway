import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Route-map regression test (Issue 11 — dead/duplicate routes).
// Two layers of defense:
// 1. HTTP probes: each critical path returns non-404 (catches mount-path drift).
// 2. Router walk: no route path appears more than once in any one sub-router
//    (catches duplicate dynamic registrations that silently shadow each other).

type RouteEntry = { method: string; path: string; router: string };

function collectRoutes(app: Express): RouteEntry[] {
  const routes: RouteEntry[] = [];
  // Namespace sub-routers by OBJECT IDENTITY, not by mount path.
  //
  // Express 5 compiles a mount pattern into a closure: `layer.path` is
  // undefined, `layer.regexp` is undefined, and each entry of `layer.matchers`
  // is a bare `match(input)` function with no introspectable pattern.
  // Reconstructing the mount string is therefore impossible, and the previous
  // `layer.regexp ?? layer.path ?? ''` silently collapsed EVERY sub-router into
  // one namespace — which reported the `/usage` route in the embeddings router
  // as a duplicate of the `/usage` route in the transcriptions router.
  //
  // Identity also states the invariant this test defends more faithfully:
  // "no path is registered twice in the SAME router".
  const routerIds = new WeakMap<object, string>();
  let nextRouterId = 0;
  function walk(stack: any[], prefix = '', routerId = '<root>') {
    for (const layer of stack) {
      if (layer.name === 'router' && layer.handle?.stack) {
        // Each mounted sub-router is its own namespace: same-path routes in
        // different sub-routers are distinct endpoints, not duplicates.
        let id = routerIds.get(layer.handle);
        if (id === undefined) {
          id = `r${nextRouterId++}`;
          routerIds.set(layer.handle, id);
        }
        walk(layer.handle.stack, prefix, id);
      } else if (layer.route) {
        const path = prefix + layer.route.path;
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({ method: method.toUpperCase(), path, router: routerId });
        }
      }
    }
  }
  walk((app as any).router.stack, '', '');
  return routes;
}

async function probe(app: Express, method: string, path: string, token: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: path.startsWith('/api') ? { Authorization: `Bearer ${token}` } : {},
      body: method === 'POST' ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    return res.status;
  } finally {
    server.close();
  }
}

describe('route-map regression (Issue 11 — dead/duplicate routes)', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it('mounts each critical API path (non-404)', async () => {
    const probes: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/api/ping' },
      { method: 'GET', path: '/api/keys' },
      { method: 'GET', path: '/api/health' },
      { method: 'GET', path: '/api/custom-providers' },
      { method: 'GET', path: '/api/fallback' },
      { method: 'GET', path: '/api/models' },
      { method: 'GET', path: '/api/analytics/summary' },
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/responses' },
      { method: 'POST', path: '/v1/audio/transcriptions' },
      { method: 'POST', path: '/v1/audio/translations' },
      { method: 'GET', path: '/api/transcriptions' },
      { method: 'GET', path: '/api/realtime' },
    ];
    for (const { method, path } of probes) {
      const status = await probe(app, method, path, token);
      expect(status, `${method} ${path} returned ${status} (expected non-404)`).not.toBe(404);
    }
  });

  it('does not mount any non-root route more than once in a single router', () => {
    // Root '/' routes are expected to repeat across sub-routers (each mounted
    // at a different prefix). We only flag duplicates of specific paths.
    const routes = collectRoutes(app).filter(r => r.path !== '/');
    const seen = new Map<string, number>();
    for (const r of routes) {
      const key = `${r.method} ${r.path} @${r.router}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, count]) => count > 1);
    expect(dupes, `duplicate routes: ${dupes.map(([k, c]) => `${k} (${c}x)`).join(', ')}`).toEqual([]);
  });

  it('mounts /v1/chat/completions and /v1/responses routes', () => {
    const routes = collectRoutes(app);
    const chat = routes.filter(r => r.path.endsWith('/chat/completions'));
    expect(chat.length).toBeGreaterThanOrEqual(1);
    expect(chat.every(r => r.method === 'POST')).toBe(true);

    const responses = routes.filter(r => r.path.endsWith('/responses'));
    expect(responses.length).toBeGreaterThanOrEqual(1);
    expect(responses.every(r => r.method === 'POST')).toBe(true);
  });
});
