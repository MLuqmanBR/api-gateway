import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

/**
 * End-to-end proof that a media request actually reaches an upstream carrying
 * its media: the gateway picks a capable model, the adapter emits the provider
 * wire shape, and the bytes arrive.
 *
 * Everything here runs against a real HTTP stub upstream — no provider keys,
 * no network. That is what makes it a genuine end-to-end assertion rather than
 * a unit test of the translator.
 */
describe('media requests reach an upstream (audio + video)', () => {
  let app: Express;
  let key: string;
  let upstream: Server;
  let upstreamPort: number;
  let lastBody: Record<string, unknown> | null = null;
  let lastPath = '';
  let lastAuth = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Stub upstream speaking the OpenAI chat-completions wire shape.
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastPath = req.url ?? '';
        lastAuth = String(req.headers.authorization ?? '');
        try {
          lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          lastBody = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub-1',
          object: 'chat.completion',
          created: 1,
          model: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content: 'received' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;

    const db = getDb();

    // A custom provider pointing at the stub, plus a model flagged audio+video
    // capable (an operator would set these from the dashboard).
    db.prepare(
      `INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('stubmedia', 'Stub Media', ?)`,
    ).run(`http://127.0.0.1:${upstreamPort}/v1`);
    const modelRow = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, monthly_token_budget, context_window, enabled,
        supports_vision, supports_audio_input, supports_video_input, modalities_manual)
      VALUES ('stubmedia', 'stub-multimodal', 'Stub Multimodal', 1, 1, 'Frontier', '', 128000, 1, 1, 1, 1, 1)
    `).run();
    const modelDbId = Number(modelRow.lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 0, 1)').run(modelDbId);

    const k = encrypt('stub-key-123');
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('stubmedia', 'main', ?, ?, ?, 'unknown', 1)`,
    ).run(k.encrypted, k.iv, k.authTag);

    app = createApp();
    key = getUnifiedApiKey();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function post(body: unknown): Promise<{ status: number; text: string; routedVia: string | null }> {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        text: await res.text(),
        routedVia: res.headers.get('x-routed-via'),
      };
    } finally {
      server.close();
    }
  }

  it('an audio request reaches the upstream with its audio part intact', async () => {
    const audioB64 = Buffer.from('fake-wav-bytes').toString('base64');
    const { status, routedVia } = await post({
      model: 'stubmedia/stub-multimodal',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'transcribe' },
          { type: 'input_audio', input_audio: { data: audioB64, format: 'wav' } },
        ],
      }],
    });

    expect(status).toBe(200);
    // The router chose the audio-capable model…
    expect(routedVia).toBe('stubmedia/stub-multimodal');
    // …the request hit the provider's chat path with the key…
    expect(lastPath).toContain('/chat/completions');
    expect(lastAuth).toBe('Bearer stub-key-123');
    // …and the audio bytes survived the whole pipeline.
    expect(JSON.stringify(lastBody)).toContain(audioB64);
    expect(JSON.stringify(lastBody)).toContain('input_audio');
  });

  it('a video request reaches the upstream with its video part intact', async () => {
    const videoUrl = 'data:video/mp4;base64,VIDEOBYTES';
    const { status, routedVia } = await post({
      model: 'stubmedia/stub-multimodal',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what happens?' },
          { type: 'video_url', video_url: { url: videoUrl } },
        ],
      }],
    });

    expect(status).toBe(200);
    expect(routedVia).toBe('stubmedia/stub-multimodal');
    expect(JSON.stringify(lastBody)).toContain(videoUrl);
  });

  it('an image request reaches the upstream with its image part intact', async () => {
    const imageUrl = 'data:image/png;base64,IMAGEBYTES';
    const { status } = await post({
      model: 'stubmedia/stub-multimodal',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    });
    expect(status).toBe(200);
    expect(JSON.stringify(lastBody)).toContain(imageUrl);
  });
});
