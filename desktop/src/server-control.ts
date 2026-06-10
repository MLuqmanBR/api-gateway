import { app } from 'electron';
import path from 'node:path';
import {
  startServer,
  type StartOptions,
  type ServerHandle,
} from './server-host.js';
import { loadConfig, saveConfig, type DesktopConfig } from './config.js';

export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

let handle: ServerHandle | null = null;
let state: ServerState = 'stopped';
let lastError: string | null = null;
let dbPath = '';
let clientDist = '';

export function getServerState(): ServerState {
  return state;
}

export function getServerError(): string | null {
  return lastError;
}

export function getServerPort(): number | null {
  return handle?.port ?? null;
}

/** Start from scratch with fresh config. Called on first launch and restart. */
export async function boot(cfg: DesktopConfig): Promise<number> {
  const userData = app.getPath('userData');
  dbPath = path.join(userData, 'freeapi.db');
  const repoRoot =
    process.env.FREEAPI_REPO ??
    path.resolve(import.meta.dirname ?? __dirname, '../..');
  clientDist = app.isPackaged
    ? path.join(process.resourcesPath, 'client-dist')
    : path.join(repoRoot, 'client/dist');

  const port = await _doStart(cfg);
  saveConfig({ ...cfg, port });
  return port;
}

export async function restart(): Promise<number> {
  await _doStop();
  const cfg = loadConfig();
  return _doStart(cfg);
}

export async function stopServer(): Promise<void> {
  await _doStop();
}

async function _doStart(cfg: DesktopConfig): Promise<number> {
  state = 'starting';
  lastError = null;
  const opts: StartOptions = {
    dbPath,
    clientDist,
    host: '127.0.0.1',
    preferredPort: cfg.port ?? 31415,
  };
  handle = await startServer(opts);
  state = 'running';
  return handle.port;
}

async function _doStop(): Promise<void> {
  if (handle) {
    const { promise, resolve } = Promise.withResolvers<void>();
    handle.server.close(() => resolve());
    await promise;
    handle = null;
  }
  state = 'stopped';
}
