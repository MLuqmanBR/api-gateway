// Configuration export / import routes. Three endpoints sit behind the
// standard /api/config prefix:
//
//   GET  /api/config/inventory  → row counts per exportable section
//   POST /api/config/export     → returns a JSON envelope (download or
//                                 preview); accepts an optional passphrase
//                                 to encrypt api_keys.
//   POST /api/config/preview    → validates + counts an envelope without
//                                 applying anything.
//   POST /api/config/import     → applies an envelope. Supports dryRun,
//                                 merge modes, and a passphrase for
//                                 passphrase-encrypted keys blobs.
//
// All three are gated by requireAuth via the app-level mount. The export
// endpoint never includes server-side secrets beyond the user's own API
import express, { Router } from 'express';
import type { Request, Response } from 'express';

import { z } from 'zod';
import {
  buildExport,
  getExportInventory,
  ConfigExportError,
} from '../lib/config/export.js';
import {
  runImport,
  previewEnvelope,
  ConfigImportError,
} from '../lib/config/import.js';

export const configRouter = Router();

// ── Inventory ─────────────────────────────────────────────────────────────

configRouter.get('/inventory', (_req: Request, res: Response) => {
  res.json(getExportInventory());
});

// ── Export ────────────────────────────────────────────────────────────────

const exportRequestSchema = z.object({
  sections: z.array(z.enum([
    'models', 'fallback_chain', 'custom_providers', 'api_keys',
    'embeddings', 'settings', 'quirks',
  ])).max(16).optional(),
  passphrase: z.string().min(1).max(1024).optional(),
  label: z.string().max(120).optional(),
  // When `true`, set the Content-Disposition to attachment so the browser
  // downloads a file. Otherwise the JSON is returned inline (used by the
  // "Copy to clipboard" preview flow).
  download: z.boolean().optional(),
});

configRouter.post('/export', (req: Request, res: Response) => {
  const parsed = exportRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map((e) => e.message).join(', ') } });
    return;
  }
  let envelope;
  try {
    envelope = buildExport(parsed.data);
  } catch (err) {
    if (err instanceof ConfigExportError) {
      res.status(err.status).json({ error: { message: err.message } });
      return;
    }
    throw err;
  }
  const body = JSON.stringify(envelope, null, 2);
  if (parsed.data.download) {
    // Match the client-side `API_Gateway-Backup-YYYY-MM-DD-HH-mm-ss.json`
    // shape. The server is in UTC, but the client will rebuild the
    // filename in its own local timezone on download — this header is
    // a hint, not authoritative. We still emit a sane UTC filename so
    // that direct fetches (curl, scripts) get a polished name too.
    const stamp = exportedAtUtcStamp(envelope.exportedAt);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="API_Gateway-Backup-${stamp}.json"`);
  } else {
    res.setHeader('Content-Type', 'application/json');
  }
  res.send(body);
});

/** Format an ISO 8601 UTC timestamp as `YYYY-MM-DD-HH-mm-ss`. */
function exportedAtUtcStamp(iso: string): string {
  // `envelope.exportedAt` is always ISO 8601 in UTC. Replace the `T`
  // separator and strip the trailing `Z` + sub-second fraction.
  return iso.replace(/\.\d+/, '').replace('T', '-').replace(/Z$/, '').replace(/:/g, '-');
}

// ── Preview ───────────────────────────────────────────────────────────────

configRouter.post('/preview', (req: Request, res: Response) => {
  try {
    const result = previewEnvelope(req.body);
    res.json({
      sections: result.sections,
      schemaVersion: result.envelope.schemaVersion,
      generator: result.envelope.generator,
      exportedAt: result.envelope.exportedAt,
      label: result.envelope.label,
      hasKeysCipher: Boolean(result.envelope.keysCipher),
    });
  } catch (err) {
    if (err instanceof ConfigImportError) {
      res.status(err.status).json({ error: { message: err.message } });
      return;
    }
    throw err;
  }
});

// ── Import ────────────────────────────────────────────────────────────────

// Cap inbound envelope size to 5 MB — generous for thousands of models
// and quirks, far below the app-wide 10 MB body limit. A schema-valid
// envelope larger than this should be split, not blocked by the limiter.
const IMPORT_BODY_LIMIT = '5mb';

configRouter.post('/import', express.json({ limit: IMPORT_BODY_LIMIT }), (req: Request, res: Response) => {
  try {
    const { envelope, options } = (req.body ?? {}) as { envelope?: unknown; options?: unknown };
    const result = runImport({ envelope, options: options as Parameters<typeof runImport>[0]['options'] });
    res.json(result);
  } catch (err) {
    if (err instanceof ConfigImportError) {
      res.status(err.status).json({ error: { message: err.message } });
      return;
    }
    throw err;
  }
});


