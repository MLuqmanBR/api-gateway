import crypto from 'crypto';
import type { DatabasePort, Statement } from './types.js';
import { createDatabase, backendName } from './backend.js';
import { getDataDir } from '../lib/data-dir.js';
import fs from 'fs';
import path from 'path';
import { migrateDbSchema } from './migrations.js';

let db: DatabasePort;
let _initialized = false;

// M24: per-connection prepared-statement cache for the routing hot path.
// `getDb()` can be rebound by tests (initDb(path)), so the cache is reset on
// every init. Statements are keyed by full SQL text; the LRU cap guards
// against callers that build SQL with unbounded literals (keys in SET
// clauses, etc.). Read-only assumptions: cached statements are only ever
// used for SELECTs on stable schemas — migrations complete before traffic.
const stmtCache = new Map<string, Statement>();
const STMT_CACHE_MAX = 128;

/** Prepare once, reuse across requests. Hot-path callers only (routeRequest
 *  key chain, budget pricing read, per-request baseline queries). Writing
 *  through a cached statement is fine (same effect as prepare+run); the
 *  cache key is the exact SQL string so parameterised statements share. */
export function cachedPrepare(sql: string): Statement {
  const cached = stmtCache.get(sql);
  if (cached !== undefined) {
    // Refresh LRU ordering — cheap (delete+set), no allocation.
    stmtCache.delete(sql);
    stmtCache.set(sql, cached);
    return cached;
  }
  const stmt = getDb().prepare(sql);
  if (stmtCache.size >= STMT_CACHE_MAX) {
    const oldest = stmtCache.keys().next();
    if (!oldest.done) stmtCache.delete(oldest.value);
  }
  stmtCache.set(sql, stmt);
  return stmt;
}


export function getDb(): DatabasePort {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath?: string): DatabasePort {
  // Guard only the singleton (no-arg) path so accidental double-init in
  // production never opens a second WAL connection on the same file.
  // Explicit paths (tests, import scripts) always create a fresh connection.
  if (_initialized && dbPath === undefined) return db;
  _initialized = true;
  // M24: drop cached statements — they belong to the previous connection.
  stmtCache.clear();
  // Resolved lazily (not at module load) so API_GATEWAY_DATA_DIR from a
  // dotenv-loaded .env is honored when env.js runs first.
  const resolvedPath = dbPath ?? path.join(getDataDir(), 'api-gateway.db');
  const isMemory = resolvedPath === ':memory:';

  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = createDatabase(resolvedPath);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrateDbSchema(db);

  console.log(`Database initialized at ${resolvedPath} (${backendName})`);
  return db;
}

export function getUnifiedApiKey(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!row) throw new Error('unified_api_key not initialized — run settings setup first');
  return row.value;
}

export function regenerateUnifiedKey(): string {
  // L06: upsert, never a bare UPDATE — a missing settings row must not turn
  // regeneration into a silent no-op that still hands out the new key.
  const key = `api-gateway-${crypto.randomBytes(24).toString('hex')}`;
  setSetting('unified_api_key', key);
  return key;
}

// Generic key/value settings accessors (used by routing strategy, etc.).
// M24: cached prepared statement — getSetting fires per-request from the
// router (strategy refresh, thresholds, queue flags).
export function getSetting(key: string): string | undefined {
  const row = cachedPrepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
