#!/usr/bin/env -S npx tsx
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, statSync, renameSync, readlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCES_FILE = join(ROOT, '.api-gateway.instances');
const LOG_FILE = join(ROOT, 'server.log');

// Log rotation: cap the active log at 50 MiB; keep at most 3 archived copies.
// Worst-case footprint is therefore ~150 MiB. Rotation happens between
// sessions (i.e. on `api start`, before opening the write fd) so we never
// rename a file that the running server is still appending to.
const LOG_MAX_BYTES = 50 * 1024 * 1024;
const LOG_ARCHIVES = 3;
const LOG_ARCHIVE_FMT = (i) => join(ROOT, `server.log.${i}`);

function rotateLogIfNeeded() {
  // One-shot rescue: if any prior archive is far above the cap, drop it
  // outright. This handles the legacy 11 GB server.log case after this
  // rotation policy was added; once everything is at ≤ LOG_MAX_BYTES, this
  // path is dead code.
  for (const path of [LOG_FILE, ...Array.from({ length: LOG_ARCHIVES }, (_, i) => LOG_ARCHIVE_FMT(i + 1))]) {
    let size;
    try { size = statSync(path).size; } catch { continue; }
    if (size > 4 * LOG_MAX_BYTES) {
      try { unlinkSync(path); } catch {}
    }
  }

  let size;
  try { size = statSync(LOG_FILE).size; }
  catch { return; }
  if (size < LOG_MAX_BYTES) return;
  // Drop the oldest archive, shift the rest down, then move active → .1.
  try { unlinkSync(LOG_ARCHIVE_FMT(LOG_ARCHIVES)); } catch {}
  for (let i = LOG_ARCHIVES - 1; i >= 1; i--) {
    try { renameSync(LOG_ARCHIVE_FMT(i), LOG_ARCHIVE_FMT(i + 1)); }
    catch {}
  }
  try { renameSync(LOG_FILE, LOG_ARCHIVE_FMT(1)); }
  catch {}
}


function usage() {
  console.log(`
API-Gateway CLI

  api start [--port <number>]   Start the server (uses .env PORT by default)
  api stop [--port <number>]    Stop a specific instance, or the only one
  api stop --all                Stop all running instances
  api restart                   Stop then start (uses .env PORT)
  api status                    Show running instances
  api list                      List all instances across ports
  api build                     Build the project
  api logs                      Tail the server log
  api help                      Show this help

After start, the server runs in the background. Access the dashboard
at http://localhost:3001 and the API at http://localhost:3001/v1.
`);
}

function readInstances() {
  try { return JSON.parse(readFileSync(INSTANCES_FILE, 'utf8')); } catch { return {}; }
}

function writeInstances(inst) {
  writeFileSync(INSTANCES_FILE, JSON.stringify(inst, null, 2));
}

function readPort() {
  try {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    return m ? parseInt(m[1], 10) : 3001;
  } catch { return 3001; }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// PIDs get recycled by the OS. `isRunning` only proves *some* process has
// that PID right now — if the server we started has since died and the PID
// was reassigned to an unrelated process, a liveness check alone can't tell
// the difference, and SIGTERM would land on the wrong process. Before
// signalling, confirm the PID still looks like our server.
//
// On Linux we can read /proc/<pid>/cmdline and /proc/<pid>/cwd to check.
// Platforms without /proc (macOS, Windows) have no equivalently cheap,
// dependency-free way to inspect another process's argv/cwd, so we fall
// back to trusting the liveness check there, same as before this fix.
function isOurServerProcess(pid) {
  if (process.platform !== 'linux') return true;
  let cmdline;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    // /proc/<pid> vanished between the liveness check and now, or isn't
    // readable — can't confirm identity, so don't kill it.
    return false;
  }
  if (!cmdline.replace(/\0/g, ' ').includes('server/dist/index.js')) return false;
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    // Canonicalize both sides: readlinkSync gives the raw target, and ROOT
    // (derived from import.meta.url) may itself traverse a symlink — either
    // one containing a symlinked path component makes a raw string compare
    // false-negative and leaves a real, still-running server untracked.
    if (realpathSync(cwd) !== realpathSync(ROOT)) return false;
  } catch {
    // cwd link unreadable, or either path failed to canonicalize (e.g.
    // dangling symlink, permissions) — the cmdline match is already a
    // strong signal, don't fail identity over this alone.
  }
  return true;
}

function cleanInstances() {
  const inst = readInstances();
  let changed = false;
  for (const [port, pid] of Object.entries(inst)) {
    if (!isRunning(pid)) { delete inst[port]; changed = true; }
  }
  if (changed) {
    if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
    else { writeInstances(inst); }
  }
  return inst;
}

function build() {
  return new Promise((resolve, reject) => {
    console.log('Building API-Gateway…');
    const child = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });
}

function needsBuild() {
  if (!existsSync(join(ROOT, 'shared', 'dist', 'types.js'))) return true;
  if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) return true;
  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) return true;
}

async function ensureBuilt() {
  if (needsBuild()) await build();
}

// Some other process may hold the port without being recorded in our
// instances file — the classic case is the systemd user unit
// (api-gateway.service), which runs server/dist/index.js on the .env PORT
// and is not managed by this CLI. Spawning anyway makes the child die with
// EADDRINUSE and prints a misleading crash message, so probe the port
// first and refuse cleanly when something unmanaged is already listening.
function portInUse(port) {
  const { promise, resolve } = Promise.withResolvers();
  const socket = new net.Socket();
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.connect(port, '127.0.0.1');
  return promise;
}

const SYSTEMD_UNIT = 'api-gateway.service';

// The systemd user unit (api-gateway.service) runs server/dist/index.js on
// the .env PORT but is not recorded in our instances file. Detect it via
// `systemctl --user show` so status/list/stop see it like a CLI instance.
function systemdInstance() {
  try {
    const res = spawnSync('systemctl', ['--user', 'show', SYSTEMD_UNIT, '--property=ActiveState,SubState,MainPID'], { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || res.error) return null;
    const props = Object.fromEntries(res.stdout.split('\n').filter(Boolean).map((l) => {
      const idx = l.indexOf('=');
      return idx === -1 ? [l, ''] : [l.slice(0, idx), l.slice(idx + 1)];
    }));
    if (props.ActiveState !== 'active') return null;
    const pid = parseInt(props.MainPID, 10);
    if (!pid || !isRunning(pid)) return null;
    if (!isOurServerProcess(pid)) return null;
    // The unit's WorkingDirectory is the repo root; the unit was
    // installed from resources/systemd/, so locate it there.
    const unitPath = join(ROOT, 'resources', 'systemd', SYSTEMD_UNIT);
    if (!existsSync(unitPath)) return null;
    const unit = readFileSync(unitPath, 'utf8');
    const m = unit.match(/^PORT=(\d+)/m);
    return { port: m ? parseInt(m[1], 10) : 3001, pid, manager: 'systemd' };
  } catch { return null; }
}

// Combined view: CLI-managed instances (from the registry) plus the
// systemd unit if active. The systemd instance is read-only — the CLI
// must never signal it, only point at `systemctl`.
function allInstances() {
  const inst = cleanInstances();
  const sd = systemdInstance();
  const out = {};
  for (const [port, pid] of Object.entries(inst)) out[port] = { pid, manager: 'cli' };
  if (sd && !out[String(sd.port)]) out[String(sd.port)] = sd;
  return out;
}

function printSystemdHint(port) {
  console.log(`The systemd unit (${SYSTEMD_UNIT}) is running on port ${port}. It is not managed by this CLI.`);
  const unitPath = join(ROOT, 'resources', 'systemd', SYSTEMD_UNIT);
  if (existsSync(unitPath)) console.log(`Stop it with:  systemctl --user stop ${SYSTEMD_UNIT}`);
  else console.log(`Stop it with:  systemctl --user stop ${SYSTEMD_UNIT}   (unit file not found in repo — check your installed copy)`);
}

async function startServer(port) {
  const inst = cleanInstances();

  if (inst[String(port)]) {
    const pid = inst[String(port)];
    if (isRunning(pid)) {
      console.log(`Server is already running on port ${port} (PID ${pid}).`);
      printInfo(port);
      return;
    }
  }

  const sd = systemdInstance();
  if (sd && sd.port === port) {
    console.log(`Server is already running on port ${port} (systemd unit ${SYSTEMD_UNIT}, PID ${sd.pid}).`);
    printInfo(port);
    return;
  }

  if (await portInUse(port)) {
    console.log(`Port ${port} is already in use by another process (not tracked by this CLI).`);
    console.log('If that is the systemd service, manage it with: systemctl --user status api-gateway.service');
    console.log('To run a CLI-managed instance instead, stop that service first or pick a free port: api start --port <port>');
    return;
  }

  rotateLogIfNeeded();

  let out;
  try { out = openSync(LOG_FILE, 'a'); } catch { out = 'ignore'; }

  const child = spawn('node', ['server/dist/index.js'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  });

  let crashed = false;
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      crashed = true;
      const i = readInstances();
      delete i[String(port)];
      if (Object.keys(i).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
      else { writeInstances(i); }
      console.error(`Server on port ${port} exited with code ${code}. Check server.log.`);
    }
  });

  child.on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  child.unref();

  inst[String(port)] = child.pid;
  writeInstances(inst);

  console.log(`Starting server on port ${port} (PID ${child.pid})…`);
  return waitForReady(port, child).then(() => {
    console.log('Server is ready.\n');
    printInfo(port);
  }).catch((err) => {
    if (crashed) return;
    console.error(err.message);
    process.exit(1);
  });
}

function waitForReady(port, child) {
  const start = Date.now();
  const timeout = 30000;
  let stderrChunks = [];
  if (child.stderr) {
    child.stderr.on('data', (chunk) => { stderrChunks.push(chunk); });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const once = (fn) => (v) => { if (!settled) { settled = true; fn(v); } };

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        const stderrMsg = Buffer.concat(stderrChunks).toString().trim();
        const msg = stderrMsg
          ? `Server exited with code ${code}: ${stderrMsg}`
          : `Server exited with code ${code} before becoming ready`;
        once(reject)(new Error(msg));
      } else if (code === 0) {
        once(reject)(new Error('Server exited unexpectedly with code 0 before becoming ready'));
      }
    });

    const check = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) once(resolve)();
        else retry();
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => { req.destroy(); retry(); });
      function retry() {
        if (Date.now() - start > timeout) {
          once(reject)(new Error('Health check timed out after 30s. Server may have failed to start.'));
        } else {
          setTimeout(check, 500);
        }
      }
    };
    check();
  });
}

function printInfo(port) {
  console.log(`  Dashboard   http://localhost:${port}`);
  console.log(`  API base    http://localhost:${port}/v1`);
  console.log(`  OpenAI SDK  client = OpenAI({ base_url: "http://localhost:${port}/v1", api_key: "…" })`);
  console.log('');
  if (Object.keys(readInstances()).length > 1) {
    console.log(`  Stop:        api stop --port ${port}`);
    console.log(`  Stop all:    api stop --all`);
  } else {
    console.log(`  Stop:        api stop`);
  }
  console.log(`  Status:      api status`);
  console.log(`  Logs:        api logs`);
}

function stopOne(port) {
  const inst = readInstances();
  const key = String(port);
  const pid = inst[key];
  if (!pid) {
    const sd = systemdInstance();
    if (sd && sd.port === port) {
      printSystemdHint(port);
      return Promise.resolve();
    }
    console.log(`No server running on port ${port}.`);
    return Promise.resolve();
  }
  if (!isRunning(pid)) {
    console.log(`PID ${pid} on port ${port} is not running. Cleaning up.`);
    delete inst[key];
    if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
    else { writeInstances(inst); }
    return Promise.resolve();
  }
  if (!isOurServerProcess(pid)) {
    console.warn(`PID ${pid} recorded for port ${port} no longer looks like our server (identity check failed — likely PID reuse). Not sending a signal; cleaning up the stale entry instead.`);
    delete inst[key];
    if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
    else { writeInstances(inst); }
    return Promise.resolve();
  }
  console.log(`Stopping server on port ${port} (PID ${pid})…`);
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.log(`Failed: ${e.message}`); }
  return new Promise((resolve) => {
    let attempts = 0;
    const check = setInterval(() => {
      if (!isRunning(pid)) {
        clearInterval(check);
        delete inst[key];
        if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
        else { writeInstances(inst); }
        console.log('Server stopped.');
        resolve();
        return;
      }
      if (++attempts > 10) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        clearInterval(check);
        delete inst[key];
        if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
        else { writeInstances(inst); }
        console.log('Server force-stopped.');
        resolve();
      }
    }, 500);
  });
}

function stopAll() {
  const inst = cleanInstances();
  const sd = systemdInstance();
  if (sd) {
    printSystemdHint(sd.port);
    console.log('Skipping the systemd unit; stopping only CLI-managed instances.');
  }
  if (Object.keys(inst).length === 0) { console.log('No CLI-managed servers running.'); return Promise.resolve(); }
  return Promise.all(Object.keys(inst).map(port => stopOne(parseInt(port, 10))));
}

function showList() {
  const all = allInstances();
  const ports = Object.keys(all);
  if (ports.length === 0) { console.log('No servers running.'); return; }
  console.log('Running instances:');
  for (const [port, inst] of Object.entries(all)) {
    console.log(`  Port ${port} — PID ${inst.pid}${inst.manager === 'systemd' ? ' (systemd unit)' : ''}`);
  }
}

function showStatus() {
  const all = allInstances();
  const ports = Object.keys(all);
  if (ports.length === 0) { console.log('No servers running.'); return; }
  if (ports.length === 1) {
    const port = ports[0];
    const inst = all[port];
    const manager = inst.manager === 'systemd' ? ' (systemd unit)' : '';
    console.log(`Server is running on port ${port} (PID ${inst.pid})${manager}.`);
    printInfo(parseInt(port, 10));
  } else { showList(); }
}

function showLogs() {
  if (!existsSync(LOG_FILE)) { console.log('No log file found.'); return; }
  const tail = spawn('tail', ['-f', '-n', '50', LOG_FILE], { stdio: 'inherit' });
  tail.on('close', () => process.exit(0));
}

function parseFlags(argv) {
  const result = { port: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      result.port = parseInt(argv[++i], 10);
      if (!result.port || result.port < 1 || result.port > 65535) {
        console.error('Invalid port. Must be 1-65535.');
        process.exit(1);
      }
    } else if (a === '--all' || a === '-a') {
      result.all = true;
    }
  }
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help') { usage(); return; }

  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (cmd === 'build') {
    try { await build(); console.log('Build complete.'); } catch (e) { console.error(e.message); process.exit(1); }
    return;
  }

  if (cmd === 'list' || cmd === 'ls') { showList(); return; }
  if (cmd === 'status' || cmd === 'info') { showStatus(); return; }
  if (cmd === 'logs' || cmd === 'log') { showLogs(); return; }

  if (cmd === 'stop' || cmd === 'kill') {
    if (flags.all) { await stopAll(); }
    else if (flags.port) { await stopOne(flags.port); }
    else {
      const all = allInstances();
      const ports = Object.keys(all);
      if (ports.length === 0) { console.log('No servers running.'); }
      else if (ports.length === 1) {
        const inst = all[ports[0]];
        if (inst.manager === 'systemd') { printSystemdHint(inst.port); }
        else { await stopOne(parseInt(ports[0], 10)); }
      }
      else { console.log('Multiple instances running. Use --port or --all:'); showList(); process.exit(1); }
    }
    return;
  }

  if (cmd === 'restart') {
    const envPort = readPort();
    const sd = systemdInstance();
    if (sd && sd.port === envPort) {
      printSystemdHint(envPort);
      console.log('Not restarting; the unit is managed by systemd (systemctl --user restart api-gateway.service).');
      return;
    }
    const inst = cleanInstances();
    if (inst[String(envPort)]) await stopOne(envPort);
    await ensureBuilt();
    await startServer(envPort);
    return;
  }

  if (cmd === 'start') {
    const startPort = flags.port || readPort();
    await ensureBuilt();
    await startServer(startPort);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main();
