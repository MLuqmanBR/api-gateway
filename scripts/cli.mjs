#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PID_FILE = join(ROOT, '.api-gateway.pid');
const LOG_FILE = join(ROOT, 'server.log');

function usage() {
  console.log(`
API-Gateway CLI

  api --start           Build and start the server in the background
  api --stop            Stop the background server
  api --restart         Stop then start
  api --status          Show whether the server is running
  api --port <number>   Set port before starting (writes to .env)
  api --build           Only build the project, don't start
  api --logs            Tail the server log
  api --help            Show this help

After --start, the server runs in the background. Access the dashboard
at http://localhost:3001 and the API at http://localhost:3001/v1.
`);
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

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function setPort(port) {
  const envPath = join(ROOT, '.env');
  let env = '';
  try { env = readFileSync(envPath, 'utf8'); } catch { /* create */ }
  if (/^PORT=/m.test(env)) {
    env = env.replace(/^PORT=.*/m, `PORT=${port}`);
  } else {
    env += `\nPORT=${port}\n`;
  }
  writeFileSync(envPath, env);
  console.log(`Port set to ${port}.`);
}

function needsBuild() {
  if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) return true;
  if (!existsSync(join(ROOT, 'client', 'dist', 'index.html'))) return true;
  return false;
}

async function ensureBuilt() {
  if (needsBuild()) {
    await build();
  }
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

function startServer(port) {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`Server is already running (PID ${pid}) on port ${port}.`);
    printInfo(port);
    return;
  }

  if (pid) { try { unlinkSync(PID_FILE); } catch {} }

  let out;
  try { out = openSync(LOG_FILE, 'a'); } catch { out = 'ignore'; }

  const child = spawn('node', ['server/dist/index.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`Starting server (PID ${child.pid}) on port ${port}…`);

  return waitForReady(port).then(() => {
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
  console.log(`  Stop:        api --stop`);
  console.log(`  Status:      api --status`);
  console.log(`  Logs:        api --logs`);
}

function stopServer() {
  const pid = readPid();
  if (!pid) { console.log('No server PID found. Not running.'); return; }
  if (!isRunning(pid)) {
    console.log(`PID ${pid} is not running. Cleaning up stale PID file.`);
    try { unlinkSync(PID_FILE); } catch {}
    return;
  }
  console.log(`Stopping server (PID ${pid})…`);
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.log(`Failed: ${e.message}`); }

  let attempts = 0;
  const check = setInterval(() => {
    if (!isRunning(pid)) {
      clearInterval(check);
      try { unlinkSync(PID_FILE); } catch {}
      console.log('Server stopped.');
      return;
    }
    if (++attempts > 10) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      clearInterval(check);
      try { unlinkSync(PID_FILE); } catch {}
      console.log('Server force-stopped.');
    }
  }, 500);
}

function showStatus() {
  const pid = readPid();
  const port = readPort();
  if (pid && isRunning(pid)) {
    console.log(`Server is running (PID ${pid}) on port ${port}.`);
    printInfo(port);
  } else {
    if (pid) {
      console.log(`Server is not running (stale PID ${pid}).`);
      try { unlinkSync(PID_FILE); } catch {}
    } else {
      console.log('Server is not running.');
    }
  }
}

function showLogs() {
  if (!existsSync(LOG_FILE)) { console.log('No log file found.'); return; }
  const tail = spawn('tail', ['-f', '-n', '50', LOG_FILE], { stdio: 'inherit' });
  tail.on('close', () => process.exit(0));
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  const cmd = args[0];

  if (cmd === '--port' || cmd === '-p') {
    const port = parseInt(args[1], 10);
    if (!port || port < 1 || port > 65535) {
      console.error('Invalid port. Must be 1-65535.');
      process.exit(1);
    }
    setPort(port);
    return;
  }

  if (cmd === '--build' || cmd === '-b') {
    try { await build(); console.log('Build complete.'); } catch (e) { console.error(e.message); process.exit(1); }
    return;
  }

  if (cmd === '--stop' || cmd === '--kill') {
    stopServer();
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

  if (cmd === '--restart' || cmd === '-r') {
    stopServer();
    await new Promise(r => setTimeout(r, 1500));
    const port = readPort();
    await ensureBuilt();
    await startServer(port);
    return;
  }

  if (cmd === '--start' || cmd === '-s') {
    const port = readPort();
    await ensureBuilt();
    await startServer(port);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main();
