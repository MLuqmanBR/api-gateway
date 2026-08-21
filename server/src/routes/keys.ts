import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getProvider, buildProviderFor, BUILTIN_PLATFORM_SLUGS } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { clearKeyRuntimeState } from '../services/ratelimit.js';
import { clearExhaustedForKey } from '../services/key-exhaustion.js';
import { mintClientKey, listClientKeys, deleteClientKey, updateClientKey } from '../lib/client-keys.js';

export const keysRouter = Router();

// Active built-in providers — derived from the providers registry Map
// (providers/index.ts) so every new provider registration is automatically
// included here. Custom providers are NOT in this list: they are created via
// POST /api/custom-providers and have their own base URL, and their keys (if
// any) are added by hitting POST /api/keys with the custom slug.
const PLATFORMS = BUILTIN_PLATFORM_SLUGS;

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
// Platform accepts any built-in (PLATFORMS) OR a custom provider slug; the
// handler resolves it to confirm it exists.
const addKeySchema = z.object({
  platform: z.string().min(1, 'platform is required'),
  key: z.string().optional(),
  label: z.string().optional(),
});


const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

// L11: strict numeric-id guard for :id path params. parseInt('12abc') === 12
// silently accepted garbage; this accepts only whole numbers ('' and
// whitespace included — Number('') is 0).
function parseIdParam(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isInteger(n) ? n : null;
}

// List all keys (masked)
// M19: masks are cached in a module-level map keyed by key id. Previously
// every dashboard poll decrypted EVERY stored key just to compute '****xyz'
// — one AES-GCM round-trip per key per poll. The cache populates on first
// request and is invalidated whenever a key is added/updated/deleted.
const keyMaskCache = new Map<number, string>();

/** N21: exactly the columns the list endpoint SELECTs — the ciphertext trio
 *  is required for the mask; nothing else leaves the row. */
interface KeysListRow {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  status: string;
  enabled: number;
  created_at: string;
  last_checked_at: string | null;
}

function computeMask(row: KeysListRow): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function invalidateKeyMask(id?: number): void {
  if (id !== undefined) keyMaskCache.delete(id);
  else keyMaskCache.clear();
}

keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  // N21: enumerate exactly the columns this endpoint reads — the ciphertext
  // trio is required for the mask, everything else stays unpulled.
  const rows = db.prepare(`
    SELECT id, platform, label, encrypted_key, iv, auth_tag,
           base_url, status, enabled, created_at, last_checked_at
    FROM api_keys ORDER BY created_at DESC
  `).all() as KeysListRow[];

  const keys = rows.map(row => {
    let maskedKey = keyMaskCache.get(row.id as number);
    if (maskedKey === undefined) {
      maskedKey = computeMask(row);
      keyMaskCache.set(row.id as number, maskedKey);
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;

  // Resolve platform → provider. Built-ins come from the registry; custom
  // slugs come from custom_providers (and their base URL gets stamped on the
  // key row so the denormalized schema stays consistent with the new
  // canonical source of truth).
  const db = getDb();
  const provider = getProvider(platform as any) ?? buildProviderFor(platform);
  if (!provider) {
    res.status(400).json({ error: { message: `Unknown platform '${platform}'` } });
    return;
  }
  const isKeyless = provider.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  // For custom slugs, look up the base URL so the key row carries it
  // (denormalized — custom_providers is the source of truth, but having
  // base_url on api_keys keeps older queries from breaking).
  const baseUrl = (provider as { baseUrl?: string }).baseUrl ?? null;

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      // L14: persist the submitted label too — the UPDATE used to set only
      // enabled/status while the response echoed `label ?? ''`, so the stored
      // row kept its old (or empty) label and the echo lied.
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown', label = ? WHERE id = ?").run(label ?? '', existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?)
  `).run(platform, label ?? '', encrypted, iv, authTag, baseUrl);

  // M19: seed the mask cache for the new id so the first GET doesn't
  // decrypt anything for this key either.
  keyMaskCache.set(Number(result.lastInsertRowid), maskKey(keyToStore));

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(keyToStore),
    status: 'unknown',
    enabled: true,
  });
});


// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseIdParam(req.params.id as string);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  // Custom models are owned by their custom_providers row, not by a key — so
  // deleting a key never orphans its models. (The migration V23 moved the
  // cascade from here to DELETE /api/custom-providers/:slug.)
  // L13: no transaction wrapper — better-sqlite3 runs each statement
  // atomically on its own, so wrapping the single DELETE bought nothing but
  // ceremony.
  getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  invalidateKeyMask(id);
  // L13: drop this key's stale runtime state so nothing resurrects it —
  // cooldowns/usage (memory + persisted rows) and exhaustion markers would
  // otherwise linger until their TTLs (and the persisted cooldowns would
  // re-seed the exhaustion map on restart).
  clearKeyRuntimeState(id);
  clearExhaustedForKey(id);

  res.json({ success: true });
});

// Toggle all keys for a platform. Accepts built-in platforms OR a custom
// provider slug — for the latter, the slug is verified against custom_providers.
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(platform);
    if (!exists) {
      res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
      return;
    }
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Update key (toggle enable/disable or edit label)
keysRouter.patch('/:id', (req: Request, res: Response) => {

  const id = parseIdParam(req.params.id as string);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});

// ---- F3: client keys (scoped, hashed-at-rest) ----
// Mint, list, update, delete per-deployment API keys. Secret format
// <key_id>:<secret> returned ONCE on mint. Empty table = today's behavior.

const mintClientKeySchema = z.object({
  label: z.string().min(1).max(200),
});

const updateClientKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().min(1).max(200).optional(),
  expires_at_ms: z.number().int().nullable().optional(),
  model_allowlist: z.array(z.string()).nullable().optional(),
  rpm_override: z.number().int().min(1).nullable().optional(),
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
});

// Mint a new client key. Returns the full <key_id>:<secret> ONCE.
keysRouter.post('/client', (req: Request, res: Response) => {
  const parsed = mintClientKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid input' } });
    return;
  }
  try {
    const minted = mintClientKey(getDb(), parsed.data.label);
    res.status(201).json({ key: minted.key, id: minted.id, label: minted.label });
  } catch (err: any) {
    // L12: only the active-key cap is a client-side conflict (409). Every
    // other throw (DB failure, crypto error) is a server fault — mapping it
    // to 409 told the operator to "resolve the conflict" and retry against a
    // broken backend. Message matches the cap throw in lib/client-keys.ts.
    if (typeof err?.message === 'string' && err.message.startsWith('Client key cap reached')) {
      res.status(409).json({ error: { message: err.message } });
      return;
    }
    console.error('[Keys] Failed to mint client key:', err);
    res.status(500).json({ error: { message: 'Failed to mint client key' } });
  }
});

// List all client keys (masked — no secret).
keysRouter.get('/client', (_req: Request, res: Response) => {
  const keys = listClientKeys(getDb());
  res.json(keys.map(k => ({
    ...k,
    model_allowlist: k.model_allowlist ? JSON.parse(k.model_allowlist) : null,
  })));
});

// Update a client key (toggle, label, expiry, allowlist, rpm).
keysRouter.patch('/client/:id', (req: Request, res: Response) => {
  const parsed = updateClientKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid input' } });
    return;
  }
  const ok = updateClientKey(getDb(), req.params.id as string, parsed.data);
  if (!ok) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }
  res.json({ ok: true });
});

// Delete (revoke) a client key.
keysRouter.delete('/client/:id', (req: Request, res: Response) => {
  const ok = deleteClientKey(getDb(), req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: { message: 'Client key not found' } });
    return;
  }
  res.json({ ok: true });
});
