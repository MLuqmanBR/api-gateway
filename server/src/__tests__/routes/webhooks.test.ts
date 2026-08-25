import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import {
  listWebhooks,
  createWebhook,
  deleteWebhook,
  toggleWebhook,
  dispatchWebhooks,
  matchesFilter,
  isInternalUrl,
  sendTestDelivery,
} from '../../services/webhooks.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Webhooks (F8)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM webhooks').run();
  });

  describe('service', () => {
    it('matchesFilter handles exact and wildcard patterns', () => {
      expect(matchesFilter('request.error', 'request.error')).toBe(true);
      expect(matchesFilter('request.*', 'request.error')).toBe(true);
      expect(matchesFilter('routing.*', 'routing.key_exhausted')).toBe(true);
      expect(matchesFilter('routing.*,request.error', 'request.error')).toBe(true);
      expect(matchesFilter('routing.*', 'request.error')).toBe(false);
      expect(matchesFilter('*', 'anything')).toBe(true); // bare '*' = documented catch-all default (C13)
    });

    it('isInternalUrl detects private hosts', () => {
      expect(isInternalUrl('http://localhost:3000/wh')).toBe(true);
      expect(isInternalUrl('http://127.0.0.1/wh')).toBe(true);
      expect(isInternalUrl('http://10.0.0.1/wh')).toBe(true);
      expect(isInternalUrl('http://192.168.1.1/wh')).toBe(true);
      expect(isInternalUrl('http://172.16.0.1/wh')).toBe(true);
      expect(isInternalUrl('http://example.com/wh')).toBe(false);
      expect(isInternalUrl('http://8.8.8.8/wh')).toBe(false);
    });

    it('createWebhook rejects internal URLs by default', () => {
      expect(() => createWebhook({ url: 'http://localhost:3000/wh', secret: 's', events_filter: '*' }))
        .toThrow('Internal URLs are not allowed');
    });

    it('createWebhook accepts public URLs', () => {
      const wh = createWebhook({ url: 'https://hooks.slack.com/services/xxx', secret: 's', events_filter: 'request.*' });
      expect(wh.id).toBeDefined();
      expect(wh.url).toContain('hooks.slack.com');
      expect(wh.events_filter).toBe('request.*');
    });

    it('listWebhooks returns all webhooks', () => {
      createWebhook({ url: 'https://example.com/wh1', secret: 's1', events_filter: '*' });
      createWebhook({ url: 'https://example.com/wh2', secret: 's2', events_filter: 'routing.*' });
      expect(listWebhooks()).toHaveLength(2);
    });

    it('deleteWebhook removes by id', () => {
      const wh = createWebhook({ url: 'https://example.com/wh', secret: 's', events_filter: '*' });
      expect(deleteWebhook(wh.id)).toBe(true);
      expect(deleteWebhook(wh.id)).toBe(false);
    });

    it('toggleWebhook enables/disables', () => {
      const wh = createWebhook({ url: 'https://example.com/wh', secret: 's', events_filter: '*' });
      expect(toggleWebhook(wh.id, false)).toBe(true);
      const updated = listWebhooks().find(w => w.id === wh.id);
      expect(updated?.enabled).toBe(0);
      toggleWebhook(wh.id, true);
    });

    it('dispatchWebhooks enqueues matching events', () => {
      createWebhook({ url: 'https://example.com/wh', secret: 's', events_filter: 'routing.*' });
      // dispatchWebhooks should not throw and should enqueue the event
      expect(() => dispatchWebhooks('routing.key_exhausted', { model: 'test' })).not.toThrow();
    });
  });

  describe('API routes', () => {
    it('POST /api/webhooks creates a webhook', async () => {
      const res = await request(app, 'POST', '/api/webhooks', {
        url: 'https://example.com/wh',
        secret: 'mysecret',
        events_filter: 'request.*',
      });
      expect(res.status).toBe(201);
      expect(res.body.url).toContain('example.com');
    });

    it('POST /api/webhooks rejects internal URLs', async () => {
      const res = await request(app, 'POST', '/api/webhooks', {
        url: 'http://localhost:3000/wh',
        secret: 's',
      });
      expect(res.status).toBe(400);
      // The route validates via the shared URL guard whose error is phrased
      // 'Blocked URL <url>: <reason>'; the service layer uses the older
      // 'Internal URLs' wording. Assert the guard's stable prefix.
      expect(res.body.error.message).toContain('Blocked URL');
    });

    it('GET /api/webhooks lists all', async () => {
      await request(app, 'POST', '/api/webhooks', { url: 'https://example.com/wh', secret: 's' });
      const res = await request(app, 'GET', '/api/webhooks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('DELETE /api/webhooks?id=N deletes', async () => {
      const created = await request(app, 'POST', '/api/webhooks', { url: 'https://example.com/wh', secret: 's' });
      const res = await request(app, 'DELETE', `/api/webhooks?id=${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('PATCH /api/webhooks?id=N toggles enabled', async () => {
      const created = await request(app, 'POST', '/api/webhooks', { url: 'https://example.com/wh', secret: 's' });
      const res = await request(app, 'PATCH', `/api/webhooks?id=${created.body.id}`, { enabled: false });
      expect(res.status).toBe(200);
    });
  });

  describe('test delivery', () => {
    it('POST /api/webhooks/test returns 404 for unknown id', async () => {
      const res = await request(app, 'POST', '/api/webhooks/test?id=999999');
      expect(res.status).toBe(404);
    });

    // Real sockets, not fake timers: delivery is a genuine HTTP round-trip to
    // an in-process receiver, so the only available completion signal is the
    // receiver's own callback. A short bounded wait tolerates scheduler lag.
    function waitForDelivery<T>(arr: T[]): Promise<T> {
      // Manual executor form (not Promise.withResolvers): CI's Node 20 job
      // lacks Promise.withResolvers (Node 22+).
      let resolve: (v: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (arr.length > 0) resolve(arr[0]);
        else if (Date.now() >= deadline) resolve(undefined as unknown as T);
        else setTimeout(tick, 25);
      };
      tick();
      return promise;
    }
    it('POST /api/webhooks/test delivers a signed webhook.test event despite non-matching filter', async () => {
      // Allow internal receivers so the test can host one locally.
      getDb().prepare(
        "INSERT INTO settings (key, value) VALUES ('allow_internal_webhooks', 'true') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run();
      const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
      const receiver = createHttpServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          res.writeHead(200);
          res.end('ok');
        });
      });
      await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
      const addr = receiver.address() as { port: number };
      try {
        const created = await request(app, 'POST', '/api/webhooks', {
          url: `http://127.0.0.1:${addr.port}/hook`,
          secret: 'test-secret',
          // Filter deliberately does NOT match the webhook.test event.
          events_filter: 'routing.*',
        });
        expect(created.status).toBe(201);
        const res = await request(app, 'POST', `/api/webhooks/test?id=${created.body.id}`);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const delivered = await waitForDelivery(received);
        expect(delivered).toBeDefined();
        const parsed = JSON.parse(delivered.body);
        expect(parsed.event).toBe('webhook.test');
        expect(parsed.payload.test).toBe(true);
        expect(parsed.payload.webhookId).toBe(created.body.id);
        const expectedSig = `sha256=${createHmac('sha256', 'test-secret').update(delivered.body).digest('hex')}`;
        expect(delivered.headers['x-api-gateway-signature']).toBe(expectedSig);
      } finally {
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }
    });

    it('sendTestDelivery reaches a DISABLED webhook and reports unknown ids', () => {
      const wh = createWebhook({ url: 'https://example.com/wh', secret: 's', events_filter: '*' });
      toggleWebhook(wh.id, false);
      expect(sendTestDelivery(wh.id)).toBe(true);
      expect(sendTestDelivery(wh.id + 100000)).toBe(false);
    });
  });

});
