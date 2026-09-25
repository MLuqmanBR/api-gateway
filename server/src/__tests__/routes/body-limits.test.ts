import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

/**
 * The `/v1` body limit must actually be 64mb, and `/api/*` must stay at 10mb.
 *
 * This is a regression test for a subtle Express/body-parser ordering trap:
 * mounting a larger `express.json` on `/v1` AFTER the global one does NOT
 * raise the limit. Middleware runs in order, and body-parser only skips a
 * request whose stream is already consumed — which is false while the body is
 * still arriving, so the global 10mb parser rejects a large `/v1` body with a
 * 413 before the larger parser ever runs. Verified empirically against
 * express 5.2.1 while writing this suite.
 */
describe('request body limits', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  /** Bytes of slack over a limit, as a JSON body of that approximate size. */
  function jsonBody(bytes: number): string {
    return JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(bytes) }] });
  }

  it('accepts a 12mb body on /v1/chat/completions instead of 413', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: jsonBody(12 * 1024 * 1024),
      });
      const text = await res.text();
      // The request got past body parsing. It will not succeed — there are no
      // provider keys in this DB — but the failure must NOT be a body-size 413.
      expect(res.status).not.toBe(413);
      expect(text).not.toContain('request entity too large');
      expect(text).not.toContain('request_too_large');
    } finally {
      server.close();
    }
  });

  // Note: /v1/audio/* is mounted on the same /v1 parser, so a multipart upload
  // is not affected — multer owns that body, and express.json skips a
  // non-JSON content type entirely.

  it('rejects an oversized body on an /api route with 413 and a JSON error', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/fallback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: 'x'.repeat(12 * 1024 * 1024) }),
      });
      expect(res.status).toBe(413);
      const body = await res.json() as { error?: { type?: string; code?: string } };
      // A JSON envelope, not body-parser's default HTML error page.
      expect(body.error?.type).toBe('invalid_request_error');
      expect(body.error?.code).toBe('request_too_large');
    } finally {
      server.close();
    }
  });
});
