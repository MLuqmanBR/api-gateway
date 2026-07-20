/**
 * F3: client key authentication + management.
 *
 * Client keys are per-deployment / per-script credentials that let the
 * operator issue scoped API keys without sharing the unified master key.
 * Secret format: <key_id>:<secret> (e.g. ck_8f3c9a2b…:9a2b1f4e…).
 *
 * Auth flow (authenticateClientKey):
 *   1. Parse <key_id>:<secret> from the bearer token (split at first colon).
 *   2. O(1) PK lookup in client_keys by key_id.
 *   3. scrypt-hash the secret with the row's salt.
 *   4. Timing-safe compare with stored secret_hash.
 *   5. Enforce enabled + expiry.
 *
 * An empty client_keys table ⇒ unified-key-only behavior (backward-compat).
 */

import type { DatabasePort } from '../db/types.js';
import { getDb } from '../db/index.js';
import {
  generateClientKeyId, generateClientSecret, generateSalt,
  hashClientSecret, timingSafeHexEqual,
} from './crypto.js';

export interface ClientKeyRow {
  id: string;
  secret_hash: string;
  salt: string;
  label: string;
  enabled: number;
  expires_at_ms: number | null;
  model_allowlist: string | null;
  rpm_override: number | null;
  created_at_ms: number;
}

export interface AuthenticatedClientKey {
  id: string;
  modelAllowlist: string[] | null;
  rpmOverride: number | null;
}

export interface MintedClientKey {
  /** The full secret string — shown ONCE to the operator. Format: <key_id>:<secret> */
  key: string;
  id: string;
  label: string;
}

const MAX_ACTIVE_KEYS = 100;

/** Try to authenticate a bearer token as a client key. Returns null if the
 *  token is not in client-key format (<key_id>:<secret>) or the lookup fails.
 *  The caller MUST fall back to the unified-key check when this returns null. */
export function authenticateClientKey(token: string): AuthenticatedClientKey | null {
  // Client key format: ck_<hex>:<hex> — split at the FIRST colon so the
  // key_id (which never contains a colon) is the prefix.
  const colonIdx = token.indexOf(':');
  if (colonIdx < 0) return null;
  const keyId = token.slice(0, colonIdx);
  const secret = token.slice(colonIdx + 1);
  if (!keyId.startsWith('ck_') || secret.length === 0) return null;

  const db = getDb();
  const row = db.prepare(
    'SELECT id, secret_hash, salt, enabled, expires_at_ms, model_allowlist, rpm_override FROM client_keys WHERE id = ?',
  ).get(keyId) as Pick<ClientKeyRow, 'id' | 'secret_hash' | 'salt' | 'enabled' | 'expires_at_ms' | 'model_allowlist' | 'rpm_override'> | undefined;

  if (!row) return null;
  if (!row.enabled) return null;
  if (row.expires_at_ms != null && row.expires_at_ms < Date.now()) return null;

  const hash = hashClientSecret(secret, row.salt);
  if (!timingSafeHexEqual(hash, row.secret_hash)) return null;

  return {
    id: row.id,
    modelAllowlist: row.model_allowlist ? JSON.parse(row.model_allowlist) : null,
    rpmOverride: row.rpm_override,
  };
}

/** Mint a new client key. Returns the full secret string ONCE (the operator
 *  must save it — the secret is never stored in plaintext). Enforces the
 *  100-active-keys soft cap. */
export function mintClientKey(db: DatabasePort, label: string): MintedClientKey {
  const active = db.prepare('SELECT COUNT(*) as n FROM client_keys WHERE enabled = 1').get() as { n: number };
  if (active.n >= MAX_ACTIVE_KEYS) {
    throw new Error(`Client key cap reached (${MAX_ACTIVE_KEYS} active). Disable or delete an existing key first.`);
  }
  const id = generateClientKeyId();
  const secret = generateClientSecret();
  const salt = generateSalt();
  const secretHash = hashClientSecret(secret, salt);
  db.prepare(
    `INSERT INTO client_keys (id, secret_hash, salt, label, enabled, created_at_ms)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(id, secretHash, salt, label.slice(0, 200), Date.now());
  return { key: `${id}:${secret}`, id, label };
}

/** List all client keys (masked — no secret). */
export function listClientKeys(db: DatabasePort): Array<Omit<ClientKeyRow, 'secret_hash' | 'salt'>> {
  return db.prepare(
    `SELECT id, label, enabled, expires_at_ms, model_allowlist, rpm_override, created_at_ms
     FROM client_keys ORDER BY created_at_ms DESC`,
  ).all() as Array<Omit<ClientKeyRow, 'secret_hash' | 'salt'>>;
}

/** Delete (revoke) a client key by id. */
export function deleteClientKey(db: DatabasePort, id: string): boolean {
  const result = db.prepare('DELETE FROM client_keys WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Update a client key (toggle enable, set label, expiry, model allowlist,
 *  rpm override). At least one field must be provided. */
export function updateClientKey(
  db: DatabasePort,
  id: string,
  updates: { enabled?: boolean; label?: string; expires_at_ms?: number | null; model_allowlist?: string[] | null; rpm_override?: number | null },
): boolean {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); args.push(updates.enabled ? 1 : 0); }
  if (updates.label !== undefined) { sets.push('label = ?'); args.push(updates.label.slice(0, 200)); }
  if (updates.expires_at_ms !== undefined) { sets.push('expires_at_ms = ?'); args.push(updates.expires_at_ms); }
  if (updates.model_allowlist !== undefined) { sets.push('model_allowlist = ?'); args.push(JSON.stringify(updates.model_allowlist)); }
  if (updates.rpm_override !== undefined) { sets.push('rpm_override = ?'); args.push(updates.rpm_override); }
  if (sets.length === 0) return false;
  args.push(id);
  const result = db.prepare(`UPDATE client_keys SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return result.changes > 0;
}
