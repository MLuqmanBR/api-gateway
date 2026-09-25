import type { Request, Response, NextFunction } from 'express';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
  // M17: sanitize before logging — err.stack can carry provider error
  // text with embedded API keys, account ids, or upstream URLs; the raw
  // stack previously reached logs redaction-free even though the response
  // body goes through sanitizeProviderErrorMessage below.
  console.error('[Error]', sanitizeProviderErrorMessage(err.stack ?? err.message));

  if (res.headersSent) return next(err);

  // Body-parser's limit error sets status 413 and name PayloadTooLargeError.
  // Clients (and the dashboard upload path) key off `type`, so report the
  // OpenAI-compatible marker rather than the internal error name.
  const rawStatus = (err as Error & { status?: number }).status;
  if (rawStatus === 413) {
    res.status(413).json({
      error: {
        message: `Request body too large. The limit is 64mb for /v1 (media attachments) and 10mb elsewhere.`,
        type: 'invalid_request_error',
        code: 'request_too_large',
      },
    });
    return;
  }

  const status = rawStatus ?? 500;
  res.status(status).json({
    error: {
      message: sanitizeProviderErrorMessage(err.message),
      type: err.name ?? 'server_error',
    },
  });
}
