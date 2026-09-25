import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runTranscription } from '../../services/transcriptions.js';

/**
 * Batch audio against a stub upstream.
 *
 * Exercises the paths that were previously hardcoded to two platforms:
 * generic base-URL endpoint resolution, the base64-json body shape, key
 * resolution for a keyless provider's sentinel row, per-key request-log
 * attribution, and error redaction.
 */
describe('batch audio pipeline', () => {
  let upstream: Server;
  let upstreamPort: number;
  let lastPath = '';
  let lastContentType = '';
  let lastBody = '';
  const seenAuth: string[] = [];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastPath = req.url ?? '';
        lastContentType = String(req.headers['content-type'] ?? '');
        lastBody = Buffer.concat(chunks).toString('utf8');
        seenAuth.push(String(req.headers.authorization ?? ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: 'hello world',
          duration: 42,
          usage: { prompt_tokens: 7, completion_tokens: 3, prompt_audio_seconds: 42 },
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  /** Register a custom provider + catalog row pointing at the stub. */
  function seedProvider(slug: string, opts: { shape?: string; keyless?: boolean } = {}): number {
    const db = getDb();
    db.prepare(
      `INSERT INTO custom_providers (slug, display_name, base_url, keyless)
       VALUES (?, ?, ?, ?)`,
    ).run(slug, slug, `http://127.0.0.1:${upstreamPort}/v1`, opts.keyless ? 1 : 0);

    const res = db.prepare(`
      INSERT INTO transcription_models
        (family, platform, model_id, display_name, max_file_mb, supports_translations,
         price_per_hour_usd, priority, enabled, quota_label, shape)
      VALUES (?, ?, ?, ?, 25, 0, 0.1, 1, 1, '', ?)
    `).run(`family-${slug}`, slug, `model-${slug}`, `Model ${slug}`, opts.shape ?? 'multipart');
    return Number(res.lastInsertRowid);
  }

  function seedKey(slug: string, plaintext = 'stub-key'): number {
    const k = encrypt(plaintext);
    const res = getDb().prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES (?, 'main', ?, ?, ?, 'unknown', 1)`,
    ).run(slug, k.encrypted, k.iv, k.authTag);
    return Number(res.lastInsertRowid);
  }

  function wavFile(): File {
    return new File([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], 'clip.wav', { type: 'audio/wav' });
  }

  it('posts multipart to the resolved endpoint and logs the request per key', async () => {
    seedProvider('audioalpha');
    const keyId = seedKey('audioalpha', 'alpha-secret');

    const out = await runTranscription({
      kind: 'transcriptions',
      model: 'family-audioalpha',
      fields: [],
      file: wavFile(),
    });

    expect(out.status).toBe(200);
    expect(lastPath).toBe('/v1/audio/transcriptions');
    expect(lastContentType).toContain('multipart/form-data');
    expect(lastBody).toContain('model-audioalpha');
    expect(seenAuth.at(-1)).toBe('Bearer alpha-secret');

    // Usage parsed and attributed to the key that actually served it.
    expect(out.actualSeconds).toBe(42);
    const logged = getDb().prepare(
      "SELECT key_id, status, audio_seconds FROM requests WHERE platform = 'audioalpha' ORDER BY id DESC LIMIT 1",
    ).get() as { key_id: number | null; status: string; audio_seconds: number | null };
    expect(logged.status).toBe('success');
    expect(logged.key_id).toBe(keyId);
    expect(logged.audio_seconds).toBe(42);
  });

  it('uses the base64-json shape when the catalog row says so', async () => {
    seedProvider('audiobeta', { shape: 'base64-json' });
    seedKey('audiobeta');

    const out = await runTranscription({
      kind: 'transcriptions',
      model: 'family-audiobeta',
      fields: [],
      file: wavFile(),
    });

    expect(out.status).toBe(200);
    expect(lastPath).toBe('/v1/audio/transcriptions');
    expect(lastContentType).toContain('application/json');
    const parsed = JSON.parse(lastBody) as { model: string; input_audio: { data: string; format: string } };
    expect(parsed.model).toBe('model-audiobeta');
    // The wav bytes, base64-encoded — the shape zenmux-style providers need.
    expect(parsed.input_audio.data).toBe(Buffer.from([82, 73, 70, 70, 0, 0, 0, 0]).toString('base64'));
    expect(parsed.input_audio.format).toBe('wav');
  });

  it('resolves a keyless provider sentinel key instead of skipping the row', async () => {
    // Keyless providers store a 'no-key' sentinel row (routes/keys.ts). The
    // generic path must treat it as a usable key, or every keyless audio
    // provider silently falls through the chain.
    const db = getDb();
    seedProvider('audiogamma', { keyless: true });
    const k = encrypt('no-key');
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('audiogamma', 'no-key', ?, ?, ?, 'unknown', 1)`,
    ).run(k.encrypted, k.iv, k.authTag);

    const out = await runTranscription({
      kind: 'transcriptions',
      model: 'family-audiogamma',
      fields: [],
      file: wavFile(),
    });

    expect(out.status).toBe(200);
    expect(lastPath).toBe('/v1/audio/transcriptions');
  });

  it('strips the fields a platform rejects', async () => {
    // `mistral` is a BUILT-IN provider with a hardcoded base URL, so the stub
    // cannot observe this call — intercept fetch instead. The point is the
    // generalized strip table: mistral drops prompt/response_format, and other
    // platforms pass the same fields through.
    const db = getDb();
    db.prepare(`
      INSERT INTO transcription_models
        (family, platform, model_id, display_name, max_file_mb, supports_translations,
         price_per_hour_usd, priority, enabled, quota_label, shape)
      VALUES ('mistralfamily', 'mistral', 'voxtral-test', 'Voxtral', 25, 0, 0.1, 1, 1, '', 'multipart')
    `).run();
    seedKey('mistral');

    const captured: string[] = [];
    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = (init as { body?: FormData }).body;
      if (body instanceof FormData) {
        for (const [k, v] of body.entries()) captured.push(`${k}=${v}`);
      }
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      await runTranscription({
        kind: 'transcriptions',
        model: 'mistralfamily',
        fields: [['prompt', 'ignored'], ['language', 'en']],
        file: wavFile(),
      });
    } finally {
      spy.mockRestore();
    }

    const joined = captured.join('\n');
    expect(joined).not.toContain('prompt=');
    expect(joined).toContain('language=en');
  });

  it('redacts a provider secret echoed in an upstream error', async () => {
    // A 4xx body that echoes the bearer token must not reach the requests
    // table verbatim.
    const db = getDb();
    seedProvider('audiodelta');
    const secret = 'super-secret-token-value';
    seedKey('audiodelta', secret);

    const saved = process.env.STUB_FAIL_MODE;
    process.env.STUB_FAIL_MODE = '1';
    // Point this row at a port with no listener to force a transport failure
    // that embeds the URL, then assert the stored error is sanitized.
    db.prepare("UPDATE custom_providers SET base_url = 'http://127.0.0.1:9/v1' WHERE slug = 'audiodelta'").run();

    await expect(runTranscription({
      kind: 'transcriptions',
      model: 'family-audiodelta',
      fields: [],
      file: wavFile(),
    })).rejects.toThrow();

    const logged = getDb().prepare(
      "SELECT error FROM requests WHERE platform = 'audiodelta' ORDER BY id DESC LIMIT 1",
    ).get() as { error: string | null };
    expect(logged.error).toBeTruthy();
    expect(logged.error).not.toContain(secret);
    process.env.STUB_FAIL_MODE = saved;
  });

  it('fails a row whose platform has no resolvable endpoint', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO transcription_models
        (family, platform, model_id, display_name, max_file_mb, supports_translations,
         price_per_hour_usd, priority, enabled, quota_label, shape)
      VALUES ('family-nowhere', 'nowhere-platform', 'x', 'X', 25, 0, 0.1, 1, 1, '', 'multipart')
    `).run();
    seedKey('nowhere-platform');

    await expect(runTranscription({
      kind: 'transcriptions',
      model: 'family-nowhere',
      fields: [],
      file: wavFile(),
    })).rejects.toThrow(/no audio endpoint/i);
  });
});
