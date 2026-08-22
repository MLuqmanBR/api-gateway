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
// All three are gated by requireSession via the app-level mount. Export
// key-transport policy: without a passphrase every decryptable provider
// API key is embedded in cleartext by design (machine-independent
// backups); a passphrase moves keys into keysCipher instead. Webhook
// signing secrets travel verbatim; client-key raw secrets are never
// stored anywhere and never exported.
import { Router } from 'express';
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
import { clearAllProviderConfigCache } from '../services/router.js';
import { requireSession } from '../middleware/requireAuth.js';

export const configRouter = Router();

// ── Inventory ─────────────────────────────────────────────────────────────

configRouter.get('/inventory', (_req: Request, res: Response) => {
  res.json(getExportInventory());
});

// ── Export ────────────────────────────────────────────────────────────────

const exportRequestSchema = z.object({
  sections: z.array(z.enum([
    'models', 'fallback_chain', 'custom_providers', 'api_keys',
    'client_keys', 'budgets', 'webhooks',
    'embeddings', 'settings', 'quirks',
  ])).max(16).optional(),
  passphrase: z.string().min(1).max(1024).optional(),
  label: z.string().max(120).optional(),
  // When `true`, set the Content-Disposition to attachment so the browser
  // downloads a file. Otherwise the JSON is returned inline (used by the
  // "Copy to clipboard" preview flow).
  download: z.boolean().optional(),
});

configRouter.post('/export', requireSession, (req: Request, res: Response) => {
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
    // shape (with an optional label slug inserted between the prefix
    // and the timestamp — see slugifyLabel below). The server is in
    // UTC, but the client will rebuild the filename in its own local
    // timezone on download — this header is a hint, not authoritative.
    // We still emit a sane UTC filename so that direct fetches (curl,
    // scripts) get a polished name too.
    const stamp = exportedAtUtcStamp(envelope.exportedAt);
    const slug = slugifyLabel(envelope.label);
    const base = slug
      ? `API_Gateway-Backup-${slug}-${stamp}`
      : `API_Gateway-Backup-${stamp}`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
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

/**
 * Convert a free-form export label ("Laptop staging") into a
 * filename-safe slug ("laptop-staging"). Returns an empty string when
 * the label is missing or contains no filename-safe characters. Rules
 * mirror the client-side `labelSlugify` in client/src/lib/utils.ts so
 * the server's Content-Disposition filename matches what the client
 * dashboard would generate.
 */
function slugifyLabel(label: string | undefined): string {
  if (!label) return '';
  const ascii = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!ascii) return '';
  if (ascii.length <= 32) return ascii;
  const cut = ascii.slice(0, 32);
  const lastHyphen = cut.lastIndexOf('-');
  if (lastHyphen > 16) return cut.slice(0, lastHyphen);
  return cut.replace(/-+$/, '');
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
      // Coarse classification of whether the envelope's api_keys
      // section is restorable on this gateway without further input.
      // 'compatible'              — row ciphertext decrypts under
      //                             the destination's key.
      // 'mismatch'                — row ciphertext does NOT decrypt
      //                             and there's no keysCipher blob.
      // 'encrypted-with-passphrase' — keysCipher present; operator
      //                               must supply passphrase at
      //                               import time.
      // 'plaintext'               — apiKeys[*].key is set; no key
      //                             dependency.
      // 'no-keys'                 — no api_keys section.
      keyCompatibility: result.keyCompatibility,
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

// Accepted by the app-level 10 MB cap; in-handler rejects oversized payloads.
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

configRouter.post('/import', (req: Request, res: Response) => {
  try {
    // L21: prefer the transport-declared Content-Length over re-serializing
    // the already-parsed body just to measure it (a full JSON.stringify per
    // import, for a number the client already sent). Fall back to measuring
    // only when the header is absent (chunked transfer).
    const declared = Number(req.headers['content-length']);
    const bodyBytes = Number.isSafeInteger(declared) && declared >= 0
      ? declared
      : Buffer.byteLength(JSON.stringify(req.body ?? {}));
    if (bodyBytes > MAX_IMPORT_BYTES) {
      res.status(413).json({ error: { message: 'Import envelope exceeds 5 MB' } });
      return;
    }
    const { envelope, options } = (req.body ?? {}) as { envelope?: unknown; options?: unknown };
    const result = runImport({ envelope, options: options as Parameters<typeof runImport>[0]['options'] });
    clearAllProviderConfigCache();
    res.json(result);
  } catch (err) {
    if (err instanceof ConfigImportError) {
      res.status(err.status).json({ error: { message: err.message } });
      return;
    }
    throw err;
  }
});


