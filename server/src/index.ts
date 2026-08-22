import './env.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { initDb, getDb } from './db/index.js';
import { pruneSessions } from './services/auth.js';
import { startHealthChecker, stopHealthChecker } from './services/health.js';
import { startRequestRetentionPruner, stopRequestRetentionPruner } from './services/request-retention.js';
import { rebuildExhaustionFromDB } from './services/key-exhaustion.js';
import { attachRealtimeServer } from './services/realtime.js';
import { setMessagesHttpServer } from './routes/messages.js';
import { initSecretsStore } from './middle/redaction/store.js';
import { initWebhooks } from './services/webhooks.js';
import { getDataDir } from './lib/data-dir.js';

const PORT = process.env.PORT ?? 3001;
// Dual-stack ('::') by default so the dashboard is reachable over both IPv4
// and IPv6. Hosts with IPv6 disabled fall back to IPv4-only; HOST overrides
// the default outright.
const HOST = process.env.HOST ?? '::';

// A fatal error must be recorded even when stderr is unreachable (e.g. the
// process was spawned with a piped stderr whose reader already exited).
// stderr write plus a synchronous append to <dataDir>/server-crash.log —
// one of the two always survives.
function recordFatal(label: string, detail: unknown): void {
  const text = `\n[server] ${label} @ ${new Date().toISOString()}\n  ${detail instanceof Error ? (detail.stack ?? detail.message) : detail}\n`;
  console.error(text);
  try { appendFileSync(join(getDataDir(), 'server-crash.log'), text); } catch { /* logging must never crash the crash handler */ }
}

process.on('unhandledRejection', (reason: unknown) => {
  recordFatal('Unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err: Error) => {
  recordFatal('Uncaught exception:', err);
  process.exit(1);
});
async function main() {
  initDb();
  initSecretsStore(); // B2-7: initialize encrypted known-secrets store
  initWebhooks();
  // Session pruning is best-effort: a transient DB failure must not abort
  // startup or become a fatal uncaughtException from a timer callback.
  try { pruneSessions(); } catch (err) { console.error('[Auth] Session prune failed:', err); }
  // Re-prune hourly so expired/stale sessions don't accumulate between boots.
  setInterval(() => {
    try { pruneSessions(); } catch (err) { console.error('[Auth] Session prune failed:', err); }
  }, 60 * 60 * 1000).unref();
  rebuildExhaustionFromDB();
  startRequestRetentionPruner();
  const app = createApp();

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker();
  };

  let activeServer = app.listen(Number(PORT), HOST, onReady(HOST));
  // F11: attach WebSocket Realtime API server (/v1/realtime)
  attachRealtimeServer(activeServer);
  // /v1/messages issues an internal loopback sub-request — give it the
  // server's own bound address so it never trusts the Host header.
  setMessagesHttpServer(activeServer);
  activeServer.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      activeServer = app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      attachRealtimeServer(activeServer);
      setMessagesHttpServer(activeServer);
      activeServer.on('error', (err: NodeJS.ErrnoException) => {
        console.error('\n[server] IPv4 fallback failed to start:\n  ' + (err?.message ?? err) + '\n');
        process.exit(1);
      });
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
  // Graceful shutdown (Imp 37): stop timers, close the HTTP listener, then
  // close the DB handle (WAL checkpoint) before exiting. Calling stop
  // functions is idempotent (they no-op if already stopped).
  function shutdown() {
    console.log('[server] Shutting down gracefully');
    stopHealthChecker();
    stopRequestRetentionPruner();
    activeServer.close(() => {
      try { getDb().close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 30_000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  recordFatal('Failed to start:', err);
  process.exit(1);
});
