import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync, existsSync, unlinkSync, openSync, statSync, renameSync, readlinkSync, realpathSync, writeSync, readSync, closeSync, mkdirSync, rmdirSync } from 'node:fs';
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
  const port = readPort();
  console.log(`
API-Gateway CLI

  api start [--port <number>]   Start the server (uses .env PORT by default)
  api stop [--port <number>]    Stop a specific instance, or the only one
  api stop --all                Stop all running instances
  api restart [--port <number>] Stop then start on a port (default .env PORT)
  api status                    Show running instances
  api list                      List all instances across ports
  api build                     Build the project
  api logs                      Tail the server log
  api help                      Show this help

After start, the server runs in the background. Access the dashboard
at http://localhost:${port} and the API at http://localhost:${port}/v1.
`);
}

// Registry shape: port → PID for CLI-managed instances. The systemd entry is
// never persisted here; allInstances() normalizes both into {pid, manager}.
function readInstances(): Record<string, number> {
  try { return JSON.parse(readFileSync(INSTANCES_FILE, 'utf8')); } catch { return {}; }
}

// Registry writes are atomic (tmp file + rename — a concurrent `api status`
// never sees a torn read) and serialized through a mkdir lock so two CLI
// processes can't clobber each other's entries (lost update). A lock older
// than REGISTRY_STALE_MS is assumed abandoned (crashed CLI) and taken over.
const REGISTRY_LOCK = INSTANCES_FILE + '.lock';
const REGISTRY_TMP = INSTANCES_FILE + '.tmp';
const REGISTRY_STALE_MS = 5000;

function writeInstancesAtomic(inst: Record<string, number>) {
  writeFileSync(REGISTRY_TMP, JSON.stringify(inst, null, 2));
  renameSync(REGISTRY_TMP, INSTANCES_FILE);
}

function withRegistryLock<T>(fn: () => T): T {
  const deadline = Date.now() + REGISTRY_STALE_MS + 1000;
  for (;;) {
    try { mkdirSync(REGISTRY_LOCK); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - statSync(REGISTRY_LOCK).mtimeMs > REGISTRY_STALE_MS; }
      catch { continue; } // lock vanished between mkdir and stat — retry
      if (stale || Date.now() > deadline) {
        try { rmdirSync(REGISTRY_LOCK); } catch {}
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // sync sleep
    }
  }
  try { return fn(); } finally { try { rmdirSync(REGISTRY_LOCK); } catch {} }
}

// Read-modify-write under the registry lock. The mutator sees a FRESH read
// (not a stale snapshot taken before a wait), the write is skipped when
// nothing changed, and an empty registry removes the file entirely.
function updateInstances(mutate: (inst: Record<string, number>) => void): Record<string, number> {
  return withRegistryLock(() => {
    const inst = readInstances();
    const before = JSON.stringify(inst);
    mutate(inst);
    if (JSON.stringify(inst) !== before) {
      if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
      else writeInstancesAtomic(inst);
    }
    return inst;
  });
}

function readPort(dir = ROOT) {
  try {
    const env = readFileSync(join(dir, '.env'), 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    return m ? parseInt(m[1], 10) : 3001;
  } catch { return 3001; }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the PID exists but we may not signal it (different user,
    // hardened sandbox). Treat as running — cleaning the registry entry
    // would orphan a live server we simply can't see. Only ESRCH proves
    // the PID is gone.
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
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
  return updateInstances((inst) => {
    for (const [port, pid] of Object.entries(inst)) {
      if (!isRunning(pid)) delete inst[port];
    }
  });
}

function build() {
  return new Promise<void>((resolve, reject) => {
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
    // The unit carries no `PORT=` line — the real port comes from the `.env`
    // in the unit's WorkingDirectory via dotenv. Parse that directory and read
    // its `.env`; fall back to the repo root. (H32: the old regex `^PORT=`
    // could never match the template and mis-reported 3001.)
    const unitPath = join(ROOT, 'resources', 'systemd', SYSTEMD_UNIT);
    if (!existsSync(unitPath)) return null;
    const unit = readFileSync(unitPath, 'utf8');
    const wdMatch = unit.match(/^WorkingDirectory=(.+)$/m);
    const workDir = wdMatch ? wdMatch[1].trim().replace(/^~/, process.env.HOME || '') : ROOT;
    return { port: readPort(existsSync(workDir) ? workDir : ROOT), pid, manager: 'systemd' };
  } catch { return null; }
}

// Normalized instance view shared by list/status output.
type InstanceView = { pid: number; port?: number; manager: string };

// Combined view: CLI-managed instances (from the registry) plus the
// systemd unit if active. The systemd instance is read-only — the CLI
// must never signal it, only point at `systemctl`.
function allInstances(): Record<string, InstanceView> {
  const inst = cleanInstances();
  const sd = systemdInstance();
  const out: Record<string, InstanceView> = {};
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

  // stderr is bound to the log fd for the child's whole lifetime: with a
  // 'pipe' the stream dies when this CLI exits, and every post-startup crash
  // message (uncaughtException/unhandledRejection handlers) was silently lost.
  const child = spawn('node', ['server/dist/index.js'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  });

  // No exit-handler cleanup here: this process exits right after start,
  // while the detached child keeps running, so an 'exit' listener could
  // never fire for a post-ready crash. Registry liveness is reconciled by
  // cleanInstances() at the start of every CLI command instead (M68).

  child.on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  child.unref();

  updateInstances((cur) => { cur[String(port)] = child.pid!; }); // fresh read under the lock — concurrent starts can't clobber each other

  console.log(`Starting server on port ${port} (PID ${child.pid})…`);
  return waitForReady(port, child, out).then(() => {
    console.log('Server is ready.\n');
    printInfo(port);
    // Explicit exit. child.unref() + closing child.stderr / the log fd is
    // not enough on its own: other inherited fds (the `time` wrapper's
    // pipe, TTY stdio, future code paths) can still keep the event loop
    // alive. The CLI's job is done once the server is ready — leave no
    // ambiguity. The detached child is unaffected.
    process.exit(0);
  }).catch((err) => {
    // Same single reconciliation every command uses: drop the child's stale
    // registry entry if it died mid-startup. On a slow-start timeout the PID
    // is still live, so the entry correctly survives.
    cleanInstances();
    console.error(err.message);
    process.exit(1);
  });
 }

function waitForReady(port, child, logFd) {
  const start = Date.now();
  const timeout = 30000;
  // stderr is no longer piped (it writes straight into the log fd for the
  // child's whole life).
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const once = (fn) => (v?) => { if (!settled) { settled = true; fn(v); } };

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        // Startup failure detail comes from the tail of the log file.
        let stderrMsg = '';
        try {
          const fd = openSync(LOG_FILE, 'r');
          const sz = statSync(LOG_FILE).size;
          const buf = Buffer.alloc(Math.min(4096, sz));
          readSync(fd, buf, 0, buf.length, Math.max(0, sz - buf.length));
          stderrMsg = buf.toString('utf8').trim();
          closeSync(fd);
        } catch { /* ignore */ }
        const msg = stderrMsg
          ? `Server exited with code ${code}: ${stderrMsg}`
          : `Server exited with code ${code} before becoming ready`;
        once(reject)(new Error(msg));
      } else if (code === 0) {
        once(reject)(new Error('Server exited unexpectedly with code 0 before becoming ready'));
      }
    });

    // Probe 127.0.0.1, never `localhost` — it can resolve ::1 first and
    // miss an IPv4-bound listener (the same hazard client/vite.config.ts
    // works around for its dev proxy). /api/ping is the PUBLIC readiness
    // route (mounted above the requireAuth blanket); /api/health sits
    // behind dashboard auth and would 401 whenever login is required.
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
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
  console.log(`  OpenAI SDK  const client = new OpenAI({ baseURL: "http://localhost:${port}/v1", apiKey: "..." });`);
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
  const inst = cleanInstances();
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
    updateInstances((cur) => { delete cur[key]; });
    return Promise.resolve();
  }
  if (!isOurServerProcess(pid)) {
    console.warn(`PID ${pid} recorded for port ${port} no longer looks like our server (identity check failed — likely PID reuse). Not sending a signal; cleaning up the stale entry instead.`);
    updateInstances((cur) => { delete cur[key]; });
    return Promise.resolve();
  }
  console.log(`Stopping server on port ${port} (PID ${pid})…`);
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.log(`Failed: ${(e as Error).message}`); }
  return new Promise<void>((resolve) => {
    let attempts = 0;
    const check = setInterval(() => {
      if (!isRunning(pid)) {
        clearInterval(check);
        updateInstances((cur) => { delete cur[key]; });
        console.log('Server stopped.');
        resolve();
        return;
      }
      if (++attempts > 10) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
        clearInterval(check);
        updateInstances((cur) => { delete cur[key]; });
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

// `api logs` — print the last 50 lines of the server log, then keep
// following appends. Pure-Node replacement for spawning GNU `tail -f -n 50`
// (which does not exist on Windows). Rotation happens between sessions
// (rotateLogIfNeeded), so a live follow normally only sees growth; a file
// that shrinks underneath us (manual truncation/rotation) restarts at byte 0.
function showLogs() {
  if (!existsSync(LOG_FILE)) { console.log('No log file found.'); return; }

  const TAIL_LINES = 50;
  const CHUNK = 64 * 1024;
  const FOLLOW_MS = 500;

  let startSize;
  try { startSize = statSync(LOG_FILE).size; } catch { console.log('No log file found.'); return; }

  // Backwards chunked read until we hold more than TAIL_LINES newlines
  // (or reach the start of the file).
  const chunks: Buffer[] = [];
  let newlineCount = 0;
  let pos = startSize;
  while (pos > 0 && newlineCount <= TAIL_LINES) {
    const start = Math.max(0, pos - CHUNK);
    const len = pos - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(LOG_FILE, 'r');
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    chunks.unshift(buf);
    for (let i = 0; i < buf.length; i++) { if (buf[i] === 0x0a) newlineCount++; }
    pos = start;
  }

  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // When we stopped early, the head chunk boundary split a line — drop it.
  if (pos > 0 && lines.length > 0) lines.shift();
  const out = lines.slice(-TAIL_LINES);
  if (out.length) console.log(out.join('\n'));

  // Follow appends from where the initial dump ended.
  let offset = startSize;
  setInterval(() => {
    let size;
    try { size = statSync(LOG_FILE).size; } catch { return; }
    if (size < offset) offset = 0; // truncated or rotated mid-follow
    if (size === offset) return;
    const stream = createReadStream(LOG_FILE, { start: offset, end: size - 1 });
    stream.on('data', (buf) => {
      offset += buf.length;
      if (!process.stdout.write(buf)) {
        stream.pause();
        process.stdout.once('drain', () => stream.resume());
      }
    });
    stream.on('error', () => { /* vanished under us; next tick re-stats */ });
  }, FOLLOW_MS);
}

// Flags each command accepts. Unknown flags are rejected outright instead
// of being silently ignored — a typo like `--prot 4000` used to fall back
// to the .env port with no hint anything was wrong.
const COMMAND_FLAGS = {
  start: ['--port', '-p'],
  stop: ['--port', '-p', '--all', '-a'],
  kill: ['--port', '-p', '--all', '-a'],
  restart: ['--port', '-p'],
};

function parseFlags(cmd, argv) {
  const allowed = COMMAND_FLAGS[cmd] || [];
  const result = { port: null as number | null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!allowed.includes(a)) {
      console.error(`Unknown flag "${a}" for "api ${cmd}". Valid flags: ${allowed.length ? allowed.join(', ') : 'none'}.`);
      process.exit(1);
    }
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
  const flags = parseFlags(cmd, argv.slice(1));

  // Single source of truth for registry liveness (M68): the server child is
  // detached and outlives this process, so no exit handler here can police
  // it. Before any command touches instance state, purge entries whose PID
  // is dead.
  cleanInstances();

  if (cmd === 'build') {
    try { await build(); console.log('Build complete.'); } catch (e) { console.error((e as Error).message); process.exit(1); }
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
    const targetPort = flags.port || readPort();
    const sd = systemdInstance();
    if (sd && sd.port === targetPort) {
      printSystemdHint(targetPort);
      console.log('Not restarting; the unit is managed by systemd (systemctl --user restart api-gateway.service).');
      return;
    }
    // Stop everything this CLI manages, then come back on the target port —
    // that is what makes `api restart --port 4000` MOVE the server instead
    // of leaving the old instance running beside the new one.
    const inst = cleanInstances();
    for (const port of Object.keys(inst)) await stopOne(parseInt(port, 10));
    await ensureBuilt();
    await startServer(targetPort);
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
