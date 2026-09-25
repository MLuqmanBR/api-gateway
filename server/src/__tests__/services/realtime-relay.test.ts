import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

/**
 * Real relay verification against a stub upstream websocket.
 *
 * No vendor realtime key exists on the development machine, so a local stub
 * speaking the same event names is the only honest way to prove the relay
 * forwards frames rather than inventing them.
 *
 * The regression this guards: the previous implementation replied to
 * `input_audio_buffer.append` with a canned `input_audio_buffer.committed`
 * acknowledgment and never forwarded the audio anywhere. A client could not
 * tell the difference.
 */

/** Auth is stubbed: the relay's job is frame plumbing, not authentication. */
vi.mock('../../routes/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/proxy.js')>();
  return {
    ...actual,
    extractApiToken: () => 'test-token',
    authenticateRequest: () => ({ authenticated: true }),
  };
});

import { attachRealtimeServer, resolveRealtimeUrl } from '../../services/realtime.js';

describe('realtime relay', () => {
  let app: Server;
  let appPort: number;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;

  /** Every frame the stub upstream received from the gateway. */
  let received: string[] = [];

  /**
   * Connect a client, run `send` once the socket is open, and resolve as soon as
   * `done` says the interesting events have arrived. No wall-clock sleep: the
   * promise settles on the condition, and the test's own timeout bounds a
   * genuine hang.
   */
  function connectUntil(
    send: (write: (obj: unknown) => void, on: (type: string, cb: () => void) => void) => void,
    done: (events: Array<Record<string, unknown>>) => boolean,
  ): Promise<Array<Record<string, unknown>>> {
    const { promise, resolve, reject } = Promise.withResolvers<Array<Record<string, unknown>>>();
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/v1/realtime`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    const events: Array<Record<string, unknown>> = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      ws.close();
      resolve(events);
    };

    const listeners = new Map<string, Array<() => void>>();
    const on = (type: string, cb: () => void): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    };
    ws.on('open', () => send((obj) => ws.send(JSON.stringify(obj)), on));
    ws.on('message', (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        parsed = { _raw: data.toString() };
      }
      events.push(parsed);
      for (const cb of listeners.get(String(parsed.type)) ?? []) cb();
      if (done(events)) finish();
    });
    ws.on('close', finish);
    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    return promise;
  }

  function typesOf(events: Array<Record<string, unknown>>): string[] {
    return events.map(e => String(e.type));
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    upstreamWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => upstreamWss.once('listening', () => resolve()));
    upstreamPort = (upstreamWss.address() as { port: number }).port;
    upstreamWss.on('connection', (sock) => {
      sock.on('message', (data) => {
        const raw = data.toString();
        received.push(raw);
        // Echo a delta back so the return path is observable.
        if (raw.includes('response.create')) {
          sock.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello from upstream' }));
        }
        // Acknowledge audio the way a real upstream does. audio_end_ms carries
        // a distinctive value so a client-visible ack can only have come from
        // HERE — the gateway's relay never invents one.
        if (raw.includes('input_audio_buffer.append')) {
          sock.send(JSON.stringify({ type: 'input_audio_buffer.committed', audio_end_ms: 4242 }));
        }
      });
    });

    app = createServer();
    attachRealtimeServer(app);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()));
    appPort = (app.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstreamWss.close(() => resolve()));
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });

  /** Register a custom provider + key + catalog row pointing at the stub. */
  function seedRealtimeTarget(modelId = 'stub-realtime'): void {
    const db = getDb();
    // A fresh slug per call keeps repeated seeds independent.
    const slug = `rtstub-${modelId}`;
    db.prepare(
      `INSERT INTO custom_providers (slug, display_name, base_url) VALUES (?, 'RT Stub', ?)`,
    ).run(slug, `http://127.0.0.1:${upstreamPort}/v1`);
    const k = encrypt('rt-key');
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES (?, 'main', ?, ?, ?, 'unknown', 1)`,
    ).run(slug, k.encrypted, k.iv, k.authTag);
    db.prepare(
      `INSERT INTO realtime_models (platform, model_id, display_name, priority, enabled)
       VALUES (?, ?, 'Stub Realtime', 1, 1)`,
    ).run(slug, modelId);
  }

  it('forwards audio appends upstream and never fabricates a commit ack', async () => {
    getDb().prepare('DELETE FROM realtime_models').run();
    seedRealtimeTarget('audio-case');
    received = [];
    const audioPayload = 'AAAABBBBCCCC';

    const events = await connectUntil(
      (write, on) => {
        // Send once the upstream handshake is complete. The pre-open path has
        // its own test below.
        on('realtime.connected', () => {
          write({ type: 'session.update', session: { model: 'stub-realtime' } });
          write({ type: 'input_audio_buffer.append', audio: audioPayload });
          write({ type: 'input_audio_buffer.commit' });
        });
      },
      // Wait for the UPSTREAM's marked ack to come back through the relay.
      (evs) => evs.some(e => e.type === 'input_audio_buffer.committed' && e.audio_end_ms === 4242),
    );

    expect(typesOf(events)).toContain('realtime.connected');
    // The audio bytes reached the upstream…
    expect(received.some((f) => f.includes(audioPayload))).toBe(true);
    expect(received.some((f) => f.includes('input_audio_buffer.commit'))).toBe(true);
    // …and the ack the client saw is the upstream's own, relayed verbatim.
    // (The old implementation fabricated one with audio_end_ms 0 while
    // dropping the audio entirely, so this assertion is the regression guard.)
    const acks = events.filter(e => e.type === 'input_audio_buffer.committed');
    expect(acks).toHaveLength(1);
    expect(acks[0].audio_end_ms).toBe(4242);
  });

  it('queues frames sent before the upstream socket opens instead of dropping them', async () => {
    // A real client sends `session.update` (often with the first audio append)
    // the instant IT connects, which can precede the gateway's own upstream
    // handshake. Dropping those frames would silently lose the start of every
    // session.
    getDb().prepare('DELETE FROM realtime_models').run();
    seedRealtimeTarget('queue-case');
    received = [];

    await connectUntil(
      // No waiting for realtime.connected: fire immediately on client open.
      (write) => {
        write({ type: 'input_audio_buffer.append', audio: 'PREOPENBYTES' });
      },
      () => received.some((f) => f.includes('PREOPENBYTES')),
    );

    expect(received.some((f) => f.includes('PREOPENBYTES'))).toBe(true);
  });

  it('relays an upstream response delta back to the client', async () => {
    received = [];
    const events = await connectUntil(
      (write, on) => {
        on('realtime.connected', () => {
          write({ type: 'response.create', response: { input: [{ type: 'message', role: 'user', content: 'hi' }] } });
        });
      },
      (evs) => typesOf(evs).includes('response.output_text.delta'),
    );

    const delta = events.find(e => e.type === 'response.output_text.delta');
    expect(delta?.delta).toBe('hello from upstream');
    // The frame crossed untouched.
    expect(received.some((f) => f.includes('response.create'))).toBe(true);
  });

  it('reports a clear error when no realtime model is configured', async () => {
    getDb().prepare('DELETE FROM realtime_models').run();
    received = [];

    const events = await connectUntil(
      (write) => { write({ type: 'input_audio_buffer.append', audio: 'ZZZZ' }); },
      (evs) => typesOf(evs).includes('error'),
    );

    const err = events.find(e => e.type === 'error') as
      { error?: { code?: string; message?: string } } | undefined;
    expect(err?.error?.code).toBe('no_realtime_model');
    expect(err?.error?.message).toMatch(/configured/i);
    // Nothing forwarded anywhere, and no fake ack produced.
    expect(received).toEqual([]);
    expect(typesOf(events)).not.toContain('input_audio_buffer.committed');
  });

  it('derives the upstream URL from the provider base URL', () => {
    seedRealtimeTarget('url-case');
    expect(resolveRealtimeUrl('rtstub-url-case', 'url-case'))
      .toBe(`ws://127.0.0.1:${upstreamPort}/v1/realtime?model=url-case`);
    expect(resolveRealtimeUrl('no-such-platform', 'x')).toBeNull();
  });
});
