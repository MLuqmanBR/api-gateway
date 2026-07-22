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
    const defaultDir = path.join(process.cwd(), 'server', 'data');
    secretsFilePath = path.join(defaultDir, SECRETS_FILENAME);
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

/** Deterministic 6-hex tag for a secret value. Same value → same tag within
 * a store generation, so repeated secrets map to a stable placeholder across
 * requests (required for agentic multi-turn coherence). */
function hexTagFor(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 6);
}

/** Build the canonical placeholder for a given secret value. */
function placeholderFor(value: string): string {
  return buildPlaceholder(STORE_GENERATION, hexTagFor(value));
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
    for (const e of entries) map.set(e.id, e);
    return map;
  } catch (err) {
    // Tampered file, wrong key, or corruption → treat as empty store.
    // Never crash — a broken secrets file should not take down the server.
    console.warn('[Middle] Failed to read secrets file, treating as empty:', err instanceof Error ? err.message : String(err));
    return new Map();
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

  // Atomic write: tmp file → rename. chmod 0600 before rename so the file
  // is never world-readable even momentarily.
  const tmpPath = fp + '.tmp';
  fs.writeFileSync(tmpPath, payload, 'utf8');
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
    .map(e => ({ value: e.value, placeholder: placeholderFor(e.value) }))
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

/** Add a secret. Deduplicates by value hash — returns existing id if the
 * same value is already stored. */
export function addSecret(value: string, kind: string, addedBy: 'manual' | 'ai', label?: string): string {
  const db = getDb();
  const hexTag = hexTagFor(value);
  const id = `s_${hexTag}`;
  const entries = ensureCache();

  if (entries.has(id)) return id; // dedupe — same value already stored

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
    const hexTag = hexTagFor(item.value);
    const id = `s_${hexTag}`;
    const existed = entries.has(id);
    if (!existed) {
      const entry: SecretEntry = {
        id, value: item.value, kind: item.kind,
        label: item.label ?? '', addedBy, createdAtMs: now, enabled: true,
      };
      entries.set(id, entry);
      insertStmt.run(id, item.kind, item.label ?? '', addedBy, entry.createdAtMs, maskKey(item.value));
    } else {
      insertStmt.run(id, item.kind, item.label ?? '', addedBy, now, maskKey(item.value));
    }
    results.push({ id, value: item.value, kind: item.kind, existed });
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
