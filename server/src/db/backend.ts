import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { DatabasePort } from './types.js';
import { loadNativeBackend } from './backends/native.js';
import type { SqlJsStatic } from './backends/wasm.js';
import { createWasmDatabase } from './backends/wasm.js';

const require = createRequire(import.meta.url);

let createDatabase: (path: string) => DatabasePort;
let backendName: string;

try {
  // Try the native better-sqlite3 addon first — the common case.
  // loadNativeBackend() requires the addon inside the function body so a
  // missing or broken addon throws at this call site (caught below) rather
  // than crashing the module graph at load time. The :memory: smoke test
  // proves the constructor actually works before we commit to the backend.
  const openNative = loadNativeBackend();
  openNative(':memory:').close();
  createDatabase = openNative;
  backendName = 'native (better-sqlite3)';
} catch {
  // Native addon unavailable — load the WASM backend (sql.js).
  const initSqlJs = require('sql.js') as (config?: { wasmBinary?: Buffer }) => Promise<SqlJsStatic>;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const wasmBinary = fs.readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });
  createDatabase = (path: string) => createWasmDatabase(SQL, path);
  backendName = 'wasm (sql.js)';
}

export { createDatabase, backendName };
