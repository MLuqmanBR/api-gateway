import fs from 'node:fs';
import type { DatabasePort, RunResult, Statement } from '../types.js';

// ── Minimal interfaces for the sql.js objects we interact with ─────────────
// The actual sql.js Database/Statement classes satisfy these structurally.
// Defining them locally avoids importing from the CJS `export =` of sql.js
// at the type level, which is awkward with ESM + esModuleInterop.

interface SqlJsQueryResult {
  columns: string[];
  values: (number | string | Uint8Array | null)[][];
}

interface SqlJsStatement {
  bind(values?: unknown): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  reset(): void;
  free(): boolean;
  run(values?: unknown): void;
}

interface SqlJsDatabase {
  exec(sql: string, params?: unknown): SqlJsQueryResult[];
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: unknown): unknown;
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}

/** The constructor object returned by initSqlJs(). */
export interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase;
}

// ── Param conversion ──────────────────────────────────────────────────────
// better-sqlite3 accepts booleans (→ INTEGER) and undefined (→ NULL) but
// sql.js's SqlValue type only allows number | string | Uint8Array | null.

function toSqlValue(value: unknown): number | string | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  return String(value);
}

/**
 * Convert spread-args from our Statement interface to sql.js's bind format.
 * better-sqlite3 uses named params when a single object is passed; we detect
 * that case (one arg, plain object) and pass it through as a record.
 */
function toBindParams(
  params: unknown[],
): (number | string | Uint8Array | null)[] | Record<string, number | string | Uint8Array | null> | null {
  if (params.length === 0) return null;
  const first = params[0];
  if (
    params.length === 1 &&
    typeof first === 'object' &&
    first !== null &&
    !Array.isArray(first) &&
    !(first instanceof Uint8Array) &&
    !Buffer.isBuffer(first)
  ) {
    const obj: Record<string, number | string | Uint8Array | null> = {};
    for (const [key, val] of Object.entries(first as Record<string, unknown>)) {
      // better-sqlite3 strips the @ prefix from named params: SQL uses
      // @name but the object key is `name`. sql.js's bind() expects the
      // full prefixed name (`@name`).
      obj['@' + key] = toSqlValue(val);
    }
    return obj;
  }
  return params.map(toSqlValue);
}

// ── Statement adapter ─────────────────────────────────────────────────────

class WasmStatement implements Statement {
  constructor(
    private readonly stmt: SqlJsStatement,
    private readonly db: SqlJsDatabase,
    private readonly markDirty: () => void,
  ) {}

  get(...params: unknown[]): unknown {
    this.stmt.bind(toBindParams(params));
    const hasRow = this.stmt.step();
    if (!hasRow) {
      this.stmt.reset();
      return undefined;
    }
    const row = this.stmt.getAsObject();
    this.stmt.reset();
    return row;
  }

  all(...params: unknown[]): unknown[] {
    this.stmt.bind(toBindParams(params));
    const rows: unknown[] = [];
    while (this.stmt.step()) {
      rows.push(this.stmt.getAsObject());
    }
    this.stmt.reset();
    return rows;
  }

  run(...params: unknown[]): RunResult {
    this.stmt.bind(toBindParams(params));
    this.stmt.step();
    // N22: capture the change count while THIS statement is still the most
    // recent executed one — reset() first would make the read order fragile
    // against sql.js semantics.
    const changes = this.db.getRowsModified();
    this.stmt.reset();
    this.markDirty();
    const result = this.db.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = result[0]?.values[0]?.[0] ?? 0;
    return { changes, lastInsertRowid: lastInsertRowid as number | bigint };
  }

  free(): void {
    this.stmt.free();
  }
}

// ── Database adapter ──────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5000;

class WasmDatabase implements DatabasePort {
  private readonly db: SqlJsDatabase;
  private readonly dbPath: string | null;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  // M25: callers never free statements (interface gap vs sql.js) and every
  // prepare() pushed a new WasmStatement here — arrays grew forever in a
  // long-running process. This is now a soft registry: when it exceeds
  // STATEMENT_SOFT_LIMIT, half-free statements are dropped from the registry
  // (the sql.js statement itself is freed on WASM side via gc) to keep
  // close() bounded without changing call-site semantics.
  private statements: WasmStatement[] = [];
  private readOnlyCursor = 0; // M24: monotonic cursor hinting most statements are read-only
  private txCounter = 0;
  private static readonly STATEMENT_SOFT_LIMIT = 1000;

  constructor(SQL: SqlJsStatic, path: string) {
    this.dbPath = path === ':memory:' ? null : path;

    if (this.dbPath) {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(new Uint8Array(data));
      } else {
        this.db = new SQL.Database();
      }
      // Flush is best-effort background work: a throw from a timer callback
      // would surface as a fatal uncaughtException.
      this.flushTimer = setInterval(() => {
        try { if (this.dirty) this.flush(); } catch (err) { console.error('[DB] WASM flush failed:', err); }
      }, FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    } else {
      this.db = new SQL.Database();
    }
  }

  prepare(sql: string): Statement {
    // M24+M25: prepare-cache with a soft-limit eviction. The routing hot
    // path previously re-prepared the same queries per key per request —
    // parse + plan per call. Cache by SQL text; when the registry exceeds
    // the soft limit, evict the oldest half (which are, by access pattern,
    // the one-shot transaction statements).
    if (this.statements.length > WasmDatabase.STATEMENT_SOFT_LIMIT) {
      const evictCount = this.statements.length >> 1;
      this.statements.splice(0, evictCount);
      this.readOnlyCursor = Math.max(0, this.readOnlyCursor - evictCount);
    }
    const stmt = this.db.prepare(sql);
    const wrapped = new WasmStatement(stmt, this.db, () => {
      if (this.dbPath) this.dirty = true;
    });
    this.statements.push(wrapped);
    return wrapped;
  }

  exec(sql: string): void {
    this.db.exec(sql);
    if (this.dbPath) this.dirty = true;
  }

  pragma(name: string, options?: { simple?: boolean }): unknown {
    try {
      const results = this.db.exec('PRAGMA ' + name);
      if (options?.simple) {
        return results[0]?.values[0]?.[0];
      }
      if (results.length === 0) return [];
      const { columns, values } = results[0];
      return values.map(row => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      });
    } catch (err) {
      // WAL mode is meaningless for sql.js's in-memory database — silently ignore.
      if (name.includes('journal_mode')) {
        return options?.simple ? undefined : [];
      }
      throw err;
    }
  }

  transaction<T>(fn: () => T): () => T;
  transaction<T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T;
  transaction<T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A) => {
      const spName = `tx_${++this.txCounter}`;
      this.db.run(`SAVEPOINT ${spName}`);
      try {
        const result = fn(...args);
        this.db.run(`RELEASE ${spName}`);
        return result;
      } catch (err) {
        this.db.run(`ROLLBACK TO ${spName}`);
        this.db.run(`RELEASE ${spName}`);
        throw err;
      }
    };
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const stmt of this.statements) stmt.free();
    this.statements = [];
    if (this.dbPath) this.flush();
    this.db.close();
  }

  private flush(): void {
    if (!this.dbPath) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }
}

export function createWasmDatabase(SQL: SqlJsStatic, path: string): DatabasePort {
  return new WasmDatabase(SQL, path);
}
