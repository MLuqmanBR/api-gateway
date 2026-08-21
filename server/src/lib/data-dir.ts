import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Single source of truth for the data directory (SQLite database, encrypted
 * secrets store, future runtime artifacts). Defaults to `<repo>/server/data`
 * resolved relative to this module — NOT process.cwd() — so the location is
 * identical no matter which directory the process was started from. The
 * `API_GATEWAY_DATA_DIR` environment override lets embedders (desktop app)
 * and sandboxed test runs point at isolated state without touching
 * production data. Evaluated lazily per call so dotenv-loaded values (the
 * server entrypoint imports env.js before db) are always honored.
 */
export function getDataDir(): string {
  const dir = process.env.API_GATEWAY_DATA_DIR ?? path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
