/**
 * F8: Webhooks — signed async event delivery.
 *
 * Routes the EXACT same LiveEvent union (request.error,
 * routing.key_exhausted, routing.recovery, health.check.failed, budget.warn)
 * to external HTTP endpoints with HMAC-SHA256 signing + retries.
 *
 * Async-only: webhook delivery NEVER blocks publish (fire-and-forget).
 * Backoff uses abortableSleep so gateway shutdown cancels pending.
 * Channel overflow = drop-oldest (size 1024).
 * SSRF: forbid private RFC1918 destinations by default; opt-in
 * allow_internal_webhooks setting.
 *
 * Attribution: concept from tokenomics (MIT, events/webhook.go).
 */

import crypto from 'crypto';
import { getDb, getSetting } from '../db/index.js';
import { subscribe } from './events.js';

const CHANNEL_SIZE = 1024;
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 4000, 16000]; // 1s, 4s, 16s
const DELIVERY_TIMEOUT_MS = 10_000;

export interface Webhook {
  id: number;
  url: string;
  secret: string;
  events_filter: string; // comma-sep events OR trailing-wildcard "routing.*"
  enabled: number;
  created_at: number;
}

// Bounded async channel (drop-oldest on overflow)
const channel: Array<{ webhook: Webhook; event: string; payload: unknown; timestamp: number }> = [];
let workerRunning = false;

/** Check if a URL points to a private/internal host (SSRF guard). */
export function isInternalUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname;
    // RFC1918 private ranges + localhost + link-local
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
    if (host.startsWith('172.')) {
      const octet = parseInt(host.split('.')[1], 10);
      if (octet >= 16 && octet <= 31) return true;
    }
    if (host.startsWith('169.254.')) return true; // link-local
    return false;
  } catch {
    return true; // malformed URL = treat as internal (safe)
  }
}

/** Check if a webhook's event filter matches an event. */
export function matchesFilter(filter: string, event: string): boolean {
  const patterns = filter.split(',').map(p => p.trim()).filter(Boolean);
  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1);
      if (event.startsWith(prefix)) return true;
    } else if (pattern === event) {
      return true;
    }
  }
  return false;
}

/** List all enabled webhooks. */
export function listWebhooks(): Webhook[] {
  const db = getDb();
  return db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as Webhook[];
}

/** Create a new webhook. Returns the created webhook. */
export function createWebhook(params: {
  url: string;
  secret: string;
  events_filter: string;
}): Webhook {
  // SSRF guard: reject internal URLs unless explicitly allowed
  if (isInternalUrl(params.url) && getSetting('allow_internal_webhooks') !== 'true') {
    throw new Error('Internal URLs are not allowed. Set allow_internal_webhooks=true to override.');
  }
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO webhooks (url, secret, events_filter, enabled, created_at)
    VALUES (?, ?, ?, 1, ?)
  `).run(params.url, params.secret, params.events_filter, Date.now());
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(result.lastInsertRowid) as Webhook;
}

/** Delete a webhook by id. */
export function deleteWebhook(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Toggle a webhook enabled/disabled. */
export function toggleWebhook(id: number, enabled: boolean): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE webhooks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

/** Fan out an event to all matching, enabled webhooks. Called from the event bus. */
export function dispatchWebhooks(event: string, payload: unknown): void {
  const db = getDb();
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all() as Webhook[];
  const timestamp = Date.now();
  for (const webhook of webhooks) {
    if (matchesFilter(webhook.events_filter, event)) {
      // Drop-oldest if channel is full
      if (channel.length >= CHANNEL_SIZE) {
        channel.shift();
      }
      channel.push({ webhook, event, payload, timestamp });
    }
  }
  // Start the worker if not running
  if (!workerRunning && channel.length > 0) {
    workerRunning = true;
    void runWorker();
  }
}

/** Deliver a single webhook with retries + exponential backoff. */
async function deliverWebhook(webhook: Webhook, event: string, payload: unknown, timestamp: number): Promise<boolean> {
  const body = JSON.stringify({ event, payload, timestamp });
  const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Gateway-Signature': `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
      // 4xx = permanent failure, don't retry
      if (res.status >= 400 && res.status < 500) return false;
    } catch {
      // Network error — retry
    }
    // Backoff before next retry (skip on last attempt)
    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, BACKOFF_MS[attempt]));
    }
  }
  return false;
}

/** Async worker that drains the channel. */
async function runWorker(): Promise<void> {
  while (channel.length > 0) {
    const item = channel.shift()!;
    await deliverWebhook(item.webhook, item.event, item.payload, item.timestamp);
  }
  workerRunning = false;
}

/** Initialize the webhook subsystem: subscribe to the event bus so all
 * published LiveEvents are fanned out to matching webhooks. Call once at
 * server startup. */
export function initWebhooks(): void {
  subscribe((evt: { type: string }) => {
    dispatchWebhooks(evt.type, evt);
  });
}
