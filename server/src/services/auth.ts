import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the unified API key, which authenticates the /v1 proxy
// for apps — this gates the /api/* admin surface for the human operator (#35).

// Exported so the session cookie's Max-Age (lib/session-cookie.ts) stays in
// lock-step with the DB-side session expiry.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  userId: number;
  email: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalized, hashPassword(password));
  return { userId: Number(result.lastInsertRowid), email: normalized };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .get(normalizeEmail(email)) as { id: number; email: string; password_hash: string } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

// L19: last_used is hygiene data, not an auth gate — writing it on every
// authenticated /api/* request makes each dashboard poll a write. Throttle
// to at most one UPDATE per session per 60 s (in-memory; losing an entry
// only costs one extra write).
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;
const lastUsedWrites = new Map<string, number>();

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const tokenHash = sha256(token);
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at_ms, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash) as { user_id: number; expires_at_ms: number; email: string } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    lastUsedWrites.delete(tokenHash);
    return null;
  }
  const now = Date.now();
  const lastWrite = lastUsedWrites.get(tokenHash);
  if (lastWrite === undefined || now - lastWrite >= LAST_USED_WRITE_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now, tokenHash);
    lastUsedWrites.set(tokenHash, now);
  }
  return { userId: row.user_id, email: row.email };
}
export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  const tokenHash = sha256(token);
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  lastUsedWrites.delete(tokenHash);
}

export function pruneSessions(): void {
  const now = Date.now();
  // Prune on authoritative expires_at_ms so expired sessions don't
  // accumulate. The second predicate catches sessions idle for a full
  // SESSION_TTL_MS (stale last_used) — it must use a TTL cutoff, never
  // `now` itself, which would match every session that has ever been used.
  const pruned = getDb().prepare(
    'DELETE FROM sessions WHERE (expires_at_ms IS NOT NULL AND expires_at_ms < ?) OR (last_used IS NOT NULL AND last_used < ?)',
  ).run(now, now - SESSION_TTL_MS).changes;
  if (pruned > 0) console.log(`[Auth] Pruned ${pruned} expired/stale session(s) as of ${new Date(now).toISOString()}`);
}
