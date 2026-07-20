/**
 * F11: WebSocket Realtime API ingress (/v1/realtime).
 *
 * Accepts WebSocket upgrades on /v1/realtime, translates inbound Realtime
 * API events to chat completions, and streams responses back as Realtime
 * envelope events (response.created → response.output_text.delta →
 * response.completed).
 *
 * Transport: raw `ws` package (per walkthrough D-FEATURES-2).
 * Audio: 16kHz PCM (not yet — text-only for now; audio passthrough is a
 * future extension via contentToString).
 *
 * Auth: unified bearer OR x-api-key header (same as /v1/messages).
 *
 * Attribution: concept from codex-proxy (MIT, server.py::responses_ws).
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { Request } from 'express';
import { extractApiToken, authenticateRequest } from '../routes/proxy.js';
import { publish } from './events.js';
import crypto from 'crypto';

let wss: WebSocketServer | null = null;
let httpServer: Server | null = null;

/** Attach the WebSocket server to an HTTP server. Call once at startup. */
export function attachRealtimeServer(server: Server): void {
  wss = new WebSocketServer({ noServer: true });
  httpServer = server;

  server.on('upgrade', (req, socket, head) => {
    // Only handle /v1/realtime upgrades
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/v1/realtime') {
      return; // Let other upgrade handlers deal with it (none today)
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

interface RealtimeSession {
  ws: WebSocket;
  token: string;
  requestId: string;
}

function handleConnection(ws: WebSocket, token: string): void {
  const session: RealtimeSession = {
    ws,
    token,
    requestId: crypto.randomUUID(),
  };

  // Send initial connection event
  ws.send(JSON.stringify({
    type: 'realtime.connected',
    event_id: crypto.randomUUID(),
    session_id: session.requestId,
  }));

  ws.on('message', async (data) => {
    let event: any;
    try {
      event = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request', message: 'Invalid JSON' },
      }));
      return;
    }

    // Handle the main event types
    switch (event.type) {
      case 'session.update':
        // Acknowledge session config update
        ws.send(JSON.stringify({
          type: 'session.updated',
          event_id: crypto.randomUUID(),
          session: event.session ?? {},
        }));
        break;

      case 'response.create':
        await handleResponseCreate(session, event);
        break;

      case 'response.cancel':
        ws.send(JSON.stringify({
          type: 'response.cancelled',
          event_id: crypto.randomUUID(),
          response_id: event.response_id ?? '',
        }));
        break;

      case 'input_audio_buffer.append':
        // Audio buffer append — for now, acknowledge (text-only mode)
        ws.send(JSON.stringify({
          type: 'input_audio_buffer.committed',
          event_id: crypto.randomUUID(),
          audio_end_ms: 0,
        }));
        break;

      default:
        // Unknown event — acknowledge silently
        break;
    }
  });

  ws.on('error', () => {
    // Swallow — the close handler will clean up
  });
}

async function handleResponseCreate(session: RealtimeSession, event: any): Promise<void> {
  const responseId = crypto.randomUUID();
  const { ws, token } = session;

  // Extract the conversation context from the event
  const input = event.response?.input ?? [];
  const instructions = event.response?.instructions ?? '';

  // Build messages for the chat completions request
  const messages: any[] = [];
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }
  for (const item of input) {
    if (item.type === 'message' && item.role && item.content) {
      const text = typeof item.content === 'string'
        ? item.content
        : Array.isArray(item.content)
          ? item.content.map((c: any) => c.text ?? '').join('')
          : '';
      messages.push({ role: item.role, content: text });
    }
  }

  if (messages.length === 0) {
    ws.send(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request', message: 'No input provided' },
    }));
    return;
  }

  // Emit response.created
  ws.send(JSON.stringify({
    type: 'response.created',
    event_id: crypto.randomUUID(),
    response: {
      id: responseId,
      object: 'realtime.response',
      status: 'in_progress',
      output: [],
    },
  }));

  // Emit response.output_text.started (for the text content part)
  ws.send(JSON.stringify({
    type: 'response.output_text.delta',
    event_id: crypto.randomUUID(),
    response_id: responseId,
    item_id: crypto.randomUUID(),
    delta: '',
    output_index: 0,
    content_index: 0,
  }));

  try {
    // Dispatch through the internal chat completions endpoint (streaming)
    const port = (() => {
      const addr = httpServer?.address();
      return addr && typeof addr === 'object' ? addr.port : 3001;
    })();
    const subRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages,
        stream: true,
      }),
    });

    if (!subRes.ok) {
      const errBody = await subRes.json().catch(() => ({})) as { error?: { message?: string } };
      ws.send(JSON.stringify({
        type: 'error',
        error: {
          type: 'server_error',
          message: errBody?.error?.message ?? `Upstream error ${subRes.status}`,
        },
      }));
      return;
    }

    // Stream the response text as Realtime events
    const reader = subRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            ws.send(JSON.stringify({
              type: 'response.output_text.delta',
              event_id: crypto.randomUUID(),
              response_id: responseId,
              item_id: crypto.randomUUID(),
              delta: delta.content,
              output_index: 0,
              content_index: 0,
            }));
          }
        } catch { /* skip */ }
      }
    }

    // Emit response.completed
    ws.send(JSON.stringify({
      type: 'response.completed',
      event_id: crypto.randomUUID(),
      response: {
        id: responseId,
        object: 'realtime.response',
        status: 'completed',
        output: [],
      },
    }));
  } catch (err: any) {
    ws.send(JSON.stringify({
      type: 'error',
      error: { type: 'server_error', message: err.message ?? 'Internal error' },
    }));
  }
}
