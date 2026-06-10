#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCES_FILE = join(ROOT, '.api-gateway.instances');
const LOG_FILE = join(ROOT, 'server.log');

function usage() {
  console.log(`
API-Gateway CLI

  api --start [--port <number>]   Start the server (uses .env PORT by default)
  api --stop [--port <number>]    Stop a specific instance, or the only one
  api --stop --all                Stop all running instances
  api --restart                   Stop then start (uses .env PORT)
  api --status                    Show running instances
  api --list                      List all instances across ports
  api --build                     Build the project
  api --logs                      Tail the server log
  api --help                      Show this help

After --start, the server runs in the background. Access the dashboard
at http://localhost:3001 and the API at http://localhost:3001/v1.
`);
}

function readInstances() {
  try {
    return JSON.parse(readFileSync(INSTANCES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeInstances(inst) {
  writeFileSync(INSTANCES_FILE, JSON.stringify(inst, null, 2));
}

function readPort() {
  try {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    return m ? parseInt(m[1], 10) : 3001;
  } catch {
    return 3001;
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanInstances() {
  const inst = readInstances();
  let changed = false;
  for (const [port, pid] of Object.entries(inst)) {
    if (!isRunning(pid)) {
      delete inst[port];
      changed = true;
    }
  }
  if (changed) {
    if (Object.keys(inst).length === 0) {
      try { unlinkSync(INSTANCES_FILE); } catch {}
    } else {
      writeInstances(inst);
    }
  }
  return inst;
}

function build() {
  return new Promise((resolve, reject) => {
    console.log('Building API-Gateway…');
    const child = spawn('npm', ['run', 'build'], {
      cwd: ROOT, stdio: 'inherit', shell: true,
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });
}

function needsBuild() {
  if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) return true;
  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) return true;
  return false;
}

async function ensureBuilt() {
  if (needsBuild()) await build();
}

function startServer(port) {
  const inst = cleanInstances();

  if (inst[String(port)]) {
    const pid = inst[String(port)];
    if (isRunning(pid)) {
      console.log(`Server is already running on port ${port} (PID ${pid}).`);
      printInfo(port);
      return;
    }
  }

  let out;
  try { out = openSync(LOG_FILE, 'a'); } catch { out = 'ignore'; }

  const child = spawn('node', ['server/dist/index.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  });

  let crashed = false;
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      crashed = true;
      const inst = readInstances();
      delete inst[String(port)];
      if (Object.keys(inst).length === 0) {
        try { unlinkSync(INSTANCES_FILE); } catch {}
      } else {
        writeInstances(inst);
      }
      console.error(`Server on port ${port} exited with code ${code}. Check server.log for details.`);
    }
  });

  child.unref();

  inst[String(port)] = child.pid;
  writeInstances(inst);

  console.log(`Starting server on port ${port} (PID ${child.pid})…`);

  return waitForReady(port).then(() => {
    if (crashed) return;
    console.log('Server is ready.\n');
    printInfo(port);
  });
}

function waitForReady(port) {
  const start = Date.now();
  const timeout = 30000;
  return new Promise((resolve) => {
    const check = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => { req.destroy(); retry(); });

      function retry() {
        if (Date.now() - start > timeout) {
          console.log('Server started but health check timed out. It may still be initializing.');
          resolve();
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
    console.log(`  Stop:        api --stop --port ${port}`);
    console.log(`  Stop all:    api --stop --all`);
  } else {
    console.log(`  Stop:        api --stop`);
  }
  console.log(`  Status:      api --status`);
  console.log(`  Logs:        api --logs`);
}

function stopOne(port) {
  const inst = readInstances();
  const key = String(port);
  const pid = inst[key];

  if (!pid) {
    console.log(`No server running on port ${port}.`);
    return;
  }

  if (!isRunning(pid)) {
    console.log(`PID ${pid} on port ${port} is not running. Cleaning up.`);
    delete inst[key];
    writeInstances(inst);
    if (Object.keys(inst).length === 0) { try { unlinkSync(INSTANCES_FILE); } catch {} }
    return;
  }

  console.log(`Stopping server on port ${port} (PID ${pid})…`);
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.log(`Failed: ${e.message}`); }

  let attempts = 0;
  const check = setInterval(() => {
    if (!isRunning(pid)) {
      clearInterval(check);
      delete inst[key];
      if (Object.keys(inst).length === 0) {
        try { unlinkSync(INSTANCES_FILE); } catch {}
      } else {
        writeInstances(inst);
      }
      console.log('Server stopped.');
      return;
    }
    if (++attempts > 10) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      clearInterval(check);
      delete inst[key];
      if (Object.keys(inst).length === 0) {
        try { unlinkSync(INSTANCES_FILE); } catch {}
      } else {
        writeInstances(inst);
      }
      console.log('Server force-stopped.');
    }
  }, 500);
}

function stopAll() {
  const inst = cleanInstances();
  const ports = Object.keys(inst);
  if (ports.length === 0) {
    console.log('No servers running.');
    return;
  }
  for (const port of ports) {
    stopOne(parseInt(port, 10));
  }
}

function showList() {
  const inst = cleanInstances();
  const ports = Object.keys(inst);
  if (ports.length === 0) {
    console.log('No servers running.');
    return;
  }
  console.log('Running instances:');
  for (const [port, pid] of Object.entries(inst)) {
    console.log(`  Port ${port} — PID ${pid}`);
  }
}

function showStatus() {
  const inst = cleanInstances();
  const ports = Object.keys(inst);
  if (ports.length === 0) {
    console.log('No servers running.');
    return;
  }
  if (ports.length === 1) {
    const port = ports[0];
    console.log(`Server is running on port ${port} (PID ${inst[port]}).`);
    printInfo(parseInt(port, 10));
  } else {
    showList();
  }
}

function showLogs() {
  if (!existsSync(LOG_FILE)) { console.log('No log file found.'); return; }
  const tail = spawn('tail', ['-f', '-n', '50', LOG_FILE], { stdio: 'inherit' });
  tail.on('close', () => process.exit(0));
}

function parseArgs(argv) {
  const result = { cmd: null, port: null, all: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      result.port = parseInt(argv[++i], 10);
      if (!result.port || result.port < 1 || result.port > 65535) {
        console.error('Invalid port. Must be 1-65535.');
        process.exit(1);
      }
    } else if (a === '--all' || a === '-a') {
      result.all = true;
    } else if (a.startsWith('--') || a.startsWith('-')) {
      if (!result.cmd) result.cmd = a;
    }
    i++;
  }
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const { cmd, port, all } = parseArgs(argv);

  if (cmd === '--build' || cmd === '-b') {
    try { await build(); console.log('Build complete.'); } catch (e) { console.error(e.message); process.exit(1); }
    return;
  }

  if (cmd === '--list' || cmd === '--ls') {
    showList();
    return;
  }

  if (cmd === '--status' || cmd === '--info') {
    showStatus();
    return;
  }

  if (cmd === '--logs' || cmd === '-l') {
    showLogs();
    return;
  }

  if (cmd === '--stop' || cmd === '--kill') {
    if (all) {
      stopAll();
    } else if (port) {
      stopOne(port);
    } else {
      const inst = cleanInstances();
      const ports = Object.keys(inst);
      if (ports.length === 0) {
        console.log('No servers running.');
      } else if (ports.length === 1) {
        stopOne(parseInt(ports[0], 10));
      } else {
        console.log(`Multiple instances running. Use --port or --all:`);
        showList();
        process.exit(1);
      }
    }
    return;
  }

  if (cmd === '--restart' || cmd === '-r') {
    // Restart uses .env PORT — find and stop that instance, then start
    const envPort = readPort();
    const inst = cleanInstances();
    if (inst[String(envPort)]) stopOne(envPort);
    await new Promise(r => setTimeout(r, 1500));
    await ensureBuilt();
    await startServer(envPort);
    return;
  }

  if (cmd === '--start' || cmd === '-s') {
    const startPort = port || readPort();
    await ensureBuilt();
    await startServer(startPort);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main();
