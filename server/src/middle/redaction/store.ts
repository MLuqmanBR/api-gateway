/**
 * Encrypted known-secrets store — Row B2-2.
 *
 * Secret VALUES live in an AES-256-GCM encrypted file (server/data/middle-secrets.enc).
 * The DB (middle_secret_meta) holds metadata ONLY for dashboard listing without
 * decrypting on every render. An in-memory cache avoids repeated decryption.
 *
 * Atomic writes: *.tmp → fs.renameSync, chmod 0600. A boot-time git check-ignore
 * guard refuses to write the default-path file if it isn't .gitignored.
 */

import crypto from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';
import { getDb } from '../../db/index.js';
import { getDataDir } from '../../lib/data-dir.js';
import { buildPlaceholder, type KnownSecret } from './spans.js';

const SECRETS_FILENAME = 'middle-secrets.enc';
const STORE_GENERATION = 1;

export interface SecretEntry {
  id: string;
  value: string;
  kind: string;
  label: string;
  addedBy: 'manual' | 'ai';
  createdAtMs: number;
  enabled: boolean;
}

export interface SecretMeta {
  id: string;
  kind: string;
  label: string;
  addedBy: string;
  createdAtMs: number;
  enabled: boolean;
  maskedPreview: string;
}

let secretsFilePath: string | null = null;
let gitGuardChecked = false;
let cache: Map<string, SecretEntry> | null = null;
let sortedSecrets: KnownSecret[] = [];

/** Initialize the store with a data directory. Called from server startup
 * (default: server/data/) or from tests (temp dir). When dataDir is provided
 * explicitly, the git check-ignore guard is skipped (test/override paths
 * are outside the repo). */
export function initSecretsStore(dataDir?: string): void {
  if (dataDir) {
    secretsFilePath = path.join(dataDir, SECRETS_FILENAME);
    gitGuardChecked = true; // skip guard for explicit (test) paths
  } else {
    // Same resolver as the database (lib/data-dir.ts): module-relative, not
    // cwd-relative, honoring API_GATEWAY_DATA_DIR so the store and the DB
    // always live in the same directory.
    secretsFilePath = path.join(getDataDir(), SECRETS_FILENAME);
    gitGuardChecked = false;
  }
  cache = null; // force lazy reload
}

function getFilePath(): string {
  if (!secretsFilePath) initSecretsStore();
  return secretsFilePath!;
}

/** One-time defense-in-depth: refuse to write the default-path file if it
 * isn't gitignored. Ignored for explicit (test) paths. */
function ensureGitGuard(): void {
  if (gitGuardChecked) return;
  const fp = getFilePath();
  try {
    const result = spawnSync('git', ['check-ignore', '-q', fp], { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(
        `Refusing to write middle-secrets to ${fp} — path is not .gitignored. ` +
        `Add server/data/ to .gitignore or use a custom data directory.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing to write')) throw err;
    // git not available — skip (can't enforce)
  }
  gitGuardChecked = true;
}

/** Tag width in hex chars: 12 hex = 48 bits. At ~4M distinct secrets the
 * birthday-collision probability stays ≈ 1e-6 — and `idFor` below resolves
 * even that deterministically, so a collision can never silently map two
 * different secrets onto one placeholder (the pre-48-bit bug substituted the
 * WRONG secret on un-redact at ~4k secrets). */
const TAG_HEX_WIDTH = 12;

/** Deterministic tag for a secret value (first `width` hex of sha256). Same
 * value → same tag within a store generation, so repeated secrets map to a
 * stable placeholder across requests (required for agentic multi-turn
 * coherence). */
function hexTagFor(value: string, width: number = TAG_HEX_WIDTH): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, width);
}

/** Resolve a collision-proof id for a value against the current entries:
 * returns the base 12-hex id when free (or already bound to this exact
 * value — true dedupe); on a genuine hash collision with a different value,
 * widens the tag until unique. Placeholders always derive from the stored
 * id, so widened entries stay internally consistent. */
export function idFor(value: string, entries: Map<string, SecretEntry>): string {
  const base = `s_${hexTagFor(value)}`;
  const existing = entries.get(base);
  if (!existing || existing.value === value) return base;
  for (let width = TAG_HEX_WIDTH + 1; width <= 64; width++) {
    const candidate = `s_${hexTagFor(value, width)}`;
    const held = entries.get(candidate);
    if (!held || held.value === value) return candidate;
  }
  // Unreachable (sha256 yields exactly 64 hex) — defensive last resort.
  return `s_${crypto.createHash('sha256').update(value + '\u0000' + entries.size).digest('hex').slice(0, TAG_HEX_WIDTH)}`;
}

/** Build the canonical placeholder for a stored entry. ALWAYS derived from
 * the entry id (never recomputed from the value) so collision-widened and
 * legacy-migrated entries emit exactly the placeholder they were stored as. */
function placeholderFromEntry(e: SecretEntry): string {
  return buildPlaceholder(STORE_GENERATION, e.id.slice(2));
}

function loadFromDisk(): Map<string, SecretEntry> {
  const fp = getFilePath();
  if (!fs.existsSync(fp)) return new Map();
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as { encrypted: string; iv: string; authTag: string };
    const plaintext = decrypt(parsed.encrypted, parsed.iv, parsed.authTag);
    const entries = JSON.parse(plaintext) as SecretEntry[];
    const map = new Map<string, SecretEntry>();
    for (const e of entries) {
      // Migrate legacy tag widths (pre-48-bit ids) to the current width so
      // lookups and placeholder derivation stay consistent; idFor also
      // resolves any historical collision between two stored values.
      const id = idFor(e.value, map);
      if (e.id !== id) {
        try {
          getDb().prepare('UPDATE middle_secret_meta SET id = ? WHERE id = ?').run(id, e.id);
        } catch { /* meta row absent (fresh DB, old file) — nothing to fix */ }
        e.id = id;
      }
      map.set(e.id, e);
    }
    return map;
  } catch (err) {
    // Tampered file, wrong key, or corruption. The old bytes may be
    // recoverable (e.g. the operator fixes ENCRYPTION_KEY) — QUARANTINE the
    // file before any subsequent save overwrites it. Silently treating it as
    // empty destroyed the only copy on the next addSecret (H04).
    const reason = err instanceof Error ? err.message : String(err);
    try {
      const quarantinePath = `${fp}.corrupt-${Date.now()}`;
      fs.renameSync(fp, quarantinePath);
      console.warn(`[Middle] Secrets file unreadable (${reason}) — quarantined as ${quarantinePath}; starting a fresh store`);
      return new Map();
    } catch (renameErr) {
      // Could not preserve the old bytes — refuse to start empty, because
      // the next save would irreversibly destroy possibly-recoverable data.
      throw new Error(
        `Secrets file at ${fp} is unreadable (${reason}) and could not be quarantined: ` +
        (renameErr instanceof Error ? renameErr.message : String(renameErr)) +
        ' — fix the file permissions or move it aside manually before continuing.',
      );
    }
  }
}

function saveToDisk(entries: Map<string, SecretEntry>): void {
  ensureGitGuard();
  const fp = getFilePath();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const plaintext = JSON.stringify([...entries.values()]);
  const { encrypted, iv, authTag } = encrypt(plaintext);
  const payload = JSON.stringify({ encrypted, iv, authTag });

  // Atomic write: tmp file → rename. M34: the mode goes ON the write call
  // (0644-then-chmod left a world-readable window); the explicit chmod is
  // kept for umask edges where the OS would not honor the requested mode.
  const tmpPath = fp + '.tmp';
  fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, fp);
}

function ensureCache(): Map<string, SecretEntry> {
  if (cache !== null) return cache;
  cache = loadFromDisk();
  rebuildSortedSecrets();
  return cache;
}

function rebuildSortedSecrets(): void {
  if (!cache) return;
  // Sort by length descending — findKnownSpans uses longest-first overlap
  // resolution, so presenting longer secrets first is a hint (the span engine
  // re-sorts internally, but this keeps the precompiled array consistent).
  sortedSecrets = [...cache.values()]
    .filter(e => e.enabled)
    .map(e => ({ value: e.value, placeholder: placeholderFromEntry(e) }))
    .sort((a, b) => b.value.length - a.value.length);
}

// --- Public API ---

/** List secret metadata for the dashboard. Never returns plaintext values.
 *  The maskedPreview is re-derived from the in-memory cache so it always
 *  reflects the current maskKey format, even for secrets added before a
 *  maskKey change. Falls back to the stored DB value only if the entry
 *  isn't in the cache (shouldn't happen — cache and DB stay in sync). */
export function listSecrets(): SecretMeta[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM middle_secret_meta ORDER BY created_at_ms DESC').all() as Array<{
    id: string; kind: string; label: string; added_by: string;
    created_at_ms: number; enabled: number; masked_preview: string;
  }>;
  const entries = ensureCache();
  return rows.map(r => {
    const entry = entries.get(r.id);
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      addedBy: r.added_by,
      createdAtMs: r.created_at_ms,
      enabled: r.enabled === 1,
      maskedPreview: entry ? maskKey(entry.value) : r.masked_preview,
    };
  });
}

/** Add a secret. Deduplicates by value — returns the existing id (and
 * re-enables it if it was disabled) when the same value is already stored;
 * a genuine tag collision with a DIFFERENT value is resolved by widening. */
export function addSecret(value: string, kind: string, addedBy: 'manual' | 'ai', label?: string): string {
  const db = getDb();
  const entries = ensureCache();
  const id = idFor(value, entries);
  const existing = entries.get(id);

  if (existing) {
    // Same value already stored. Re-enable if disabled so a re-observed
    // secret becomes active again without a restart (parity with bulk path).
    if (!existing.enabled) {
      existing.enabled = true;
      saveToDisk(entries);
      rebuildSortedSecrets();
      db.prepare('UPDATE middle_secret_meta SET enabled = 1 WHERE id = ?').run(id);
    }
    return id;
  }

  const entry: SecretEntry = {
    id,
    value,
    kind,
    label: label ?? '',
    addedBy,
    createdAtMs: Date.now(),
    enabled: true,
  };

  entries.set(id, entry);
  saveToDisk(entries);

  db.prepare(`
    INSERT INTO middle_secret_meta (id, kind, label, added_by, created_at_ms, enabled, masked_preview)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, enabled = 1
  `).run(id, kind, label ?? '', addedBy, entry.createdAtMs, maskKey(value));

  rebuildSortedSecrets();
  return id;
}

/** Add multiple secrets in a single disk write. Deduplicates by value hash
 *  — duplicates within the batch return the existing id with existed=true.
 *  Re-enables disabled secrets that match. */
export function addSecretsBulk(
  items: Array<{ value: string; kind: string; label?: string }>,
  addedBy: 'manual' | 'ai' = 'manual',
): Array<{ id: string; value: string; kind: string; existed: boolean }> {
  const db = getDb();
  const entries = ensureCache();
  const insertStmt = db.prepare(`
    INSERT INTO middle_secret_meta (id, kind, label, added_by, created_at_ms, enabled, masked_preview)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, enabled = 1
  `);
  const now = Date.now();
  const results: Array<{ id: string; value: string; kind: string; existed: boolean }> = [];

  for (const item of items) {
    const id = idFor(item.value, entries);
    const existing = entries.get(id);
    if (!existing) {
      const entry: SecretEntry = {
        id, value: item.value, kind: item.kind,
        label: item.label ?? '', addedBy, createdAtMs: now, enabled: true,
      };
      entries.set(id, entry);
      insertStmt.run(id, item.kind, item.label ?? '', addedBy, entry.createdAtMs, maskKey(item.value));
      results.push({ id, value: item.value, kind: item.kind, existed: false });
    } else {
      // Re-enables disabled secrets that match — BOTH the DB row (upsert
      // above) and the in-memory entry, so redaction is active again in this
      // process without a restart.
      if (!existing.enabled) {
        existing.enabled = true;
        db.prepare('UPDATE middle_secret_meta SET enabled = 1 WHERE id = ?').run(id);
      }
      insertStmt.run(id, item.kind, item.label ?? '', addedBy, now, maskKey(item.value));
      results.push({ id, value: item.value, kind: item.kind, existed: true });
    }
  }

  saveToDisk(entries);
  rebuildSortedSecrets();
  return results;
}

/** Remove a secret by id. */
export function removeSecret(id: string): void {
  const db = getDb();
  const entries = ensureCache();
  if (!entries.has(id)) return;
  entries.delete(id);
  saveToDisk(entries);
  db.prepare('DELETE FROM middle_secret_meta WHERE id = ?').run(id);
  rebuildSortedSecrets();
}

/** Enable or disable a secret without deleting it. */
export function setEnabled(id: string, enabled: boolean): void {
  const db = getDb();
  const entries = ensureCache();
  const entry = entries.get(id);
  if (!entry) return;
  entry.enabled = enabled;
  saveToDisk(entries);
  db.prepare('UPDATE middle_secret_meta SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  rebuildSortedSecrets();
}

/** Get active secrets as {value, placeholder} pairs for the span engine. */
export function getActiveSecretsForRedaction(): KnownSecret[] {
  ensureCache();
  return sortedSecrets;
}

/** Reset the cache — used by tests to force a re-read from disk. */
export function _resetCacheForTesting(): void {
  cache = null;
  sortedSecrets = [];
}
