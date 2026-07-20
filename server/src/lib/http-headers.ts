/**
 * C8: setRetryAfter — RFC 7231 delta-seconds helper for gateway 503s.
 *
 * Used on every gateway-originated 503 response so clients know when to retry.
 * Primary consumer: F9 queue-full 503. Do NOT use on 429 — the inbound
 * rate-limit middleware already sets its own Retry-After.
 */

import type { Response } from 'express';

/** Set the Retry-After header (delta-seconds) on a response. */
export function setRetryAfter(res: Response, seconds: number): void {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(seconds))));
}
