import { createRequire } from 'node:module';
import type { DatabasePort } from '../types.js';

const require = createRequire(import.meta.url);

/**
 * Load the native better-sqlite3 backend.
 *
 * The `require()` call is inside the function body (not at module top level)
 * so that a load failure can be caught by the caller's try/catch in
 * backend.ts. If the native addon is unavailable (wrong Node major, no
 * prebuilt binary, no toolchain), this throws and the WASM fallback fires.
 *
 * better-sqlite3's Database class already matches DatabasePort structurally,
 * so no wrapping is needed — the raw constructor is returned.
 */
export function loadNativeBackend(): (path: string) => DatabasePort {
  const NativeDatabase = require('better-sqlite3');
  return (path: string) => new NativeDatabase(path);
}
