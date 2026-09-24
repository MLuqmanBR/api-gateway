/**
 * F11: WebSocket Realtime API ingress (/v1/realtime).
 *
 * Proxies a client's Realtime session to a REAL upstream Realtime websocket.
 * The gateway is a relay, not an implementation: it resolves which upstream
 * serves the session, opens the upstream socket, and forwards frames in both
 * directions.
 *
 * An earlier version answered `input_audio_buffer.append` with a canned
 * `input_audio_buffer.committed` ack and looped `response.create` back through
 * the gateway's own /v1/chat/completions. That made realtime audio look like
 * it worked while silently discarding every audio byte, so the ack is gone and
 * the audio path is now a straight relay.
 *
 * Transport: raw `ws` package (per walkthrough D-FEATURES-2).
 * Auth: unified bearer OR x-api-key header (same as /v1/messages).
 *
 * Attribution: concept from codex-proxy (MIT, server.py::responses_ws).
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { Request } from 'express';
import { extractApiToken, authenticateRequest } from '../routes/proxy.js';
import { getDb } from '../db/index.js';
import { buildProviderFor } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { publish } from './events.js';
import crypto from 'crypto';

let wss: WebSocketServer | null = null;

/** Attach the WebSocket server to an HTTP server. Call once at startup. */
export function attachRealtimeServer(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // Only handle /v1/realtime upgrades — any other upgrade request MUST be
    // destroyed, otherwise the socket hangs open until the client times out.
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/v1/realtime') {
      socket.destroy();
      return;
    }

    // Auth: extract token from headers (bearer or x-api-key)
    const token = extractApiToken(req as unknown as Request);
    const auth = authenticateRequest(token);
    if (!auth.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, token ?? '');
    });
  });
}

// ── Catalog ────────────────────────────────────────────────────────────────

export interface RealtimeModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  priority: number;
  enabled: number;
}

export function listRealtimeModels(): RealtimeModelRow[] {
  return getDb().prepare(
    'SELECT * FROM realtime_models ORDER BY priority, id',
  ).all() as RealtimeModelRow[];
}

/**
 * Resolve the upstream Realtime endpoint for a catalog row.
 *
 * OpenAI-shaped providers put realtime at `${ws(s) base}/realtime?model=...`.
 * Deriving it from the provider's base URL (rather than storing a second URL)
 * means an operator who fixes a provider's base URL fixes chat, audio and
 * realtime in one edit.
 *
 * Returns null when the platform has no resolvable base URL.
 */
export function resolveRealtimeUrl(platform: string, modelId: string): string | null {
  const provider = buildProviderFor(platform);
  const base = provider?.baseUrl?.replace(/\/+$/, '');
  if (!base) return null;
  const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${wsBase}/realtime?model=${encodeURIComponent(modelId)}`;
}

/** First enabled catalog row whose platform has an enabled key, or null. */
function pickRealtimeTarget(): { row: RealtimeModelRow; apiKey: string } | null {
  const db = getDb();
  for (const row of listRealtimeModels()) {
    if (row.enabled !== 1) continue;
    if (!resolveRealtimeUrl(row.platform, row.model_id)) continue;
    const keyRow = db.prepare(
      "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY id LIMIT 1",
    ).get(row.platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!keyRow) continue;
    try {
      return { row, apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag) };
    } catch {
      continue; // undecryptable — try the next row
    }
  }
  return null;
}

// ── Session ────────────────────────────────────────────────────────────────

interface RealtimeSession {
  ws: WebSocket;
  requestId: string;
  upstream: WebSocket | null;
  target: { row: RealtimeModelRow; apiKey: string } | null;
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ event_id: crypto.randomUUID(), ...payload }));
}

function handleConnection(ws: WebSocket, token: string): void {
  void token;
  const session: RealtimeSession = {
    ws,
    requestId: crypto.randomUUID(),
    upstream: null,
    target: pickRealtimeTarget(),
  };

  // Connect to the upstream BEFORE announcing readiness, so a client that
  // starts appending audio immediately is not racing a socket that does not
  // exist yet.
  const target = session.target;
  if (!target) {
    // No realtime upstream is configured. Say so plainly: this is the honest
    // failure mode, and it must NOT look like a working session.
    send(ws, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'no_realtime_model',
        message:
          'No realtime model is configured. Add a realtime-capable provider and model '
          + 'in the dashboard (Realtime tab) and ensure its platform has an enabled API key. '
          + '/v1/realtime proxies a real upstream session; it does not synthesize audio.',
      },
    });
    ws.close();
    return;
  }

  const url = resolveRealtimeUrl(target.row.platform, target.row.model_id)!;
  const upstream = new WebSocket(url, {
    // OpenAI-style realtime auth. Providers that want a different header can
    // be added by extending this object — the relay itself is header-agnostic.
    headers: { Authorization: `Bearer ${target.apiKey}` },
  });
  session.upstream = upstream;

  upstream.on('open', () => {
    send(ws, {
      type: 'realtime.connected',
      session_id: session.requestId,
      model: `${target.row.platform}/${target.row.model_id}`,
    });
  });

  upstream.on('message', (data) => {
    // Relay frames verbatim: the upstream speaks the same Realtime protocol
    // the client does, so any translation here would only lose information.
    if (ws.readyState === WebSocket.OPEN) ws.send(data.toString());
  });

  upstream.on('error', (err: Error) => {
    send(ws, {
      type: 'error',
      error: { type: 'server_error', message: `upstream realtime error: ${err.message}` },
    });
  });

  upstream.on('close', (code: number, reason: Buffer) => {
    send(ws, {
      type: 'session.closed',
      upstream_code: code,
      upstream_reason: reason.toString().slice(0, 200),
    });
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('message', (data) => {
    try {
      const raw = data.toString();
      // Validate it is JSON so a malformed frame is reported to the client
      // rather than forwarded upstream as garbage.
      try {
        JSON.parse(raw);
      } catch {
        send(ws, { type: 'error', error: { type: 'invalid_request', message: 'Invalid JSON' } });
        return;
      }
      // Forward verbatim — including input_audio_buffer.append. No canned ack:
      // the upstream's own commit/acknowledgement events are what the client
      // must see, and inventing one here is what made the old implementation
      // look functional while dropping every audio byte.
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw);
    } catch (err) {
      console.error('[Realtime] relay error:', err instanceof Error ? err.message : err);
    }
  });

  ws.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });

  ws.on('error', () => {
    // Swallow — the close handler cleans up.
  });
}
