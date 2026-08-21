import type { Request, Response, NextFunction } from 'express';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
  // M17: sanitize before logging — err.stack can carry provider error
  // text with embedded API keys, account ids, or upstream URLs; the raw
  // stack previously reached logs redaction-free even though the response
  // body goes through sanitizeProviderErrorMessage below.
  console.error('[Error]', sanitizeProviderErrorMessage(err.stack ?? err.message));

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;
  res.status(status).json({
    error: {
      message: sanitizeProviderErrorMessage(err.message),
      type: err.name ?? 'server_error',
    },
  });
}
