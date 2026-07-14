/**
 * Database port — the contract both backends implement.
 *
 * The native backend (better-sqlite3) already matches this interface
 * structurally, so no wrapping is needed. The WASM backend (sql.js)
 * implements it via an adapter that translates each call to sql.js's API.
 *
 * All methods are synchronous, matching better-sqlite3's sync API.
 * This keeps every callsite in the codebase unchanged.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export interface DatabasePort {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(name: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): () => T;
  transaction<T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T;
  close(): void;
}
