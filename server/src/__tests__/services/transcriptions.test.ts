import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  resolveFamily,
  resolveTranscriptionModel,
  getDefaultFamily,
  estimateTranscriptionCostCents,
  runTranscription,
  TranscriptionError,
} from '../../services/transcriptions.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`) {
  const { encrypted, iv, authTag } = encrypt(raw);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
}

function wavFile(bytes = 4096): File {
  return new File([new Uint8Array(bytes)], 'clip.wav', { type: 'audio/wav' });
}

function okGroq(text = 'hello world', duration = 12) {
  return new Response(JSON.stringify({ text, duration }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okMistral(text = 'hello world', promptAudioSeconds = 12) {
  return new Response(JSON.stringify({
    text,
    usage: { prompt_audio_seconds: promptAudioSeconds, prompt_tokens: 5, completion_tokens: 3 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('transcriptions service', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  describe('migration seed', () => {
    it('seeds three transcription rows with prices and a default family', () => {
      const rows = getDb().prepare(
        'SELECT platform, model_id, price_per_hour_usd, supports_translations FROM transcription_models ORDER BY id',
      ).all() as { platform: string; model_id: string; price_per_hour_usd: number; supports_translations: number }[];
      expect(rows).toEqual([
        { platform: 'groq', model_id: 'whisper-large-v3-turbo', price_per_hour_usd: 0.04, supports_translations: 0 },
        { platform: 'groq', model_id: 'whisper-large-v3', price_per_hour_usd: 0.111, supports_translations: 1 },
        { platform: 'mistral', model_id: 'voxtral-mini-2602', price_per_hour_usd: 0.18, supports_translations: 0 },
      ]);
      expect(getDefaultFamily()).toBe('whisper-large-v3-turbo');
    });

    it('does NOT seed the retired voxtral-mini-2507', () => {
      const row = getDb().prepare("SELECT 1 FROM transcription_models WHERE model_id = 'voxtral-mini-2507'").get();
      expect(row).toBeUndefined();
    });

    it('adds the requests.audio_seconds column', () => {
      const cols = getDb().prepare('PRAGMA table_info(requests)').all() as { name: string }[];
      expect(cols.some(c => c.name === 'audio_seconds')).toBe(true);
    });
  });

  describe('resolveFamily / resolveTranscriptionModel', () => {
    it("maps 'auto', empty and undefined to the default family", () => {
      expect(resolveFamily('auto')).toBe('whisper-large-v3-turbo');
      expect(resolveFamily('')).toBe('whisper-large-v3-turbo');
      expect(resolveFamily(undefined)).toBe('whisper-large-v3-turbo');
    });

    it('accepts a family name directly', () => {
      expect(resolveFamily('whisper-large-v3')).toBe('whisper-large-v3');
    });

    it('maps a bare provider model id to its family', () => {
      expect(resolveFamily('voxtral-mini-2602')).toBe('voxtral-mini-2602');
      expect(resolveFamily('whisper-large-v3-turbo')).toBe('whisper-large-v3-turbo');
    });

    it('returns null for unknown models', () => {
      expect(resolveFamily('whisper-tiny')).toBeNull();
    });

    it('resolves a concrete row for budget pricing', () => {
      const row = resolveTranscriptionModel('whisper-large-v3');
      expect(row?.platform).toBe('groq');
      expect(row?.price_per_hour_usd).toBe(0.111);
    });
  });

  describe('estimateTranscriptionCostCents', () => {
    it('converts hours × price to integer cents, rounding up', () => {
      // 3600 s of groq turbo at $0.04/hr = $0.04 = 4 cents
      expect(estimateTranscriptionCostCents(0.04, 3600)).toBe(4);
      // 10 s minimum at $0.04/hr = 0.111 cents → ceil 1
      expect(estimateTranscriptionCostCents(0.04, 10)).toBe(1);
      // 600 s of mistral at $0.18/hr = $0.03 = 3 cents
      expect(estimateTranscriptionCostCents(0.18, 600)).toBe(3);
      // zero price (self-hosted NIM) → 0 cents, unenforced
      expect(estimateTranscriptionCostCents(0, 3600)).toBe(0);
    });
  });

  describe('runTranscription', () => {
    it('rejects unknown models with a 400', async () => {
      await expect(
        runTranscription({ kind: 'transcriptions', model: 'no-such-model', fields: [], file: wavFile() }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('routes via groq with the row model id on the wire', async () => {
      addKey('groq');
      const fetchMock = vi.fn(async () => okGroq());
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await runTranscription({
        kind: 'transcriptions',
        model: 'whisper-large-v3-turbo',
        fields: [['language', 'en']],
        file: wavFile(),
      });
      expect(result.status).toBe(200);
      expect(result.row.platform).toBe('groq');
      expect(String(fetchMock.mock.calls[0][0])).toContain('api.groq.com/openai/v1/audio/transcriptions');
      const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer groq-test-key');

      // The outbound multipart carries the catalog model id, not the client value
      const body = fetchMock.mock.calls[0][1]?.body as FormData;
      expect(body.get('model')).toBe('whisper-large-v3-turbo');
      expect(body.get('language')).toBe('en');
      expect((body.get('file') as File).name).toBe('clip.wav');

      // groq verbose_json duration feeds actualSeconds
      expect(result.actualSeconds).toBe(12);
    });

    it('routes via mistral, strips prompt/response_format, keeps repeated granularities', async () => {
      addKey('mistral');
      const fetchMock = vi.fn(async () => okMistral());
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await runTranscription({
        kind: 'transcriptions',
        model: 'voxtral-mini-2602',
        fields: [
          ['language', 'fr'],
          ['prompt', 'should be stripped'],
          ['response_format', 'verbose_json'],
          ['timestamp_granularities[]', 'word'],
          ['timestamp_granularities[]', 'segment'],
        ],
        file: wavFile(),
      });
      expect(result.row.platform).toBe('mistral');
      expect(String(fetchMock.mock.calls[0][0])).toContain('api.mistral.ai/v1/audio/transcriptions');

      const body = fetchMock.mock.calls[0][1]?.body as FormData;
      expect(body.get('model')).toBe('voxtral-mini-2602');
      expect(body.get('prompt')).toBeNull();
      expect(body.get('response_format')).toBeNull();
      expect(body.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);

      // mistral usage.prompt_audio_seconds feeds actualSeconds
      expect(result.actualSeconds).toBe(12);
    });

    it('fails over to the second key within the platform', async () => {
      addKey('groq', 'key-a');
      addKey('groq', 'key-b');
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(okGroq());
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await runTranscription({
        kind: 'transcriptions',
        model: 'whisper-large-v3-turbo',
        fields: [],
        file: wavFile(),
      });
      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const headers2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
      expect(headers2.Authorization).toBe('Bearer key-b');
    });

    it("a keyless family cannot be rescued by another platform's key", async () => {
      // whisper-large-v3-turbo's chain is groq-only. A mistral key exists,
      // but mistral serves a different family — it must not be borrowed.
      addKey('mistral');
      const fetchMock = vi.fn(async () => okMistral());
      globalThis.fetch = fetchMock as typeof fetch;

      await expect(
        runTranscription({
          kind: 'transcriptions',
          model: 'whisper-large-v3-turbo',
          fields: [],
          file: wavFile(),
        }),
      ).rejects.toMatchObject({ status: 502, message: expect.stringContaining('(no usable keys)') });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propagates 429 only when the last error is a 429; non-429 becomes 502', async () => {
      addKey('groq');
      globalThis.fetch = vi.fn(async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
      await expect(
        runTranscription({ kind: 'transcriptions', model: 'whisper-large-v3-turbo', fields: [], file: wavFile() }),
      ).rejects.toMatchObject({ status: 429 });
      globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
      await expect(
        runTranscription({ kind: 'transcriptions', model: 'whisper-large-v3-turbo', fields: [], file: wavFile() }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('throws 503 when the family has no enabled providers', async () => {
      getDb().prepare("UPDATE transcription_models SET enabled = 0 WHERE family = 'whisper-large-v3-turbo'").run();
      await expect(
        runTranscription({ kind: 'transcriptions', model: 'whisper-large-v3-turbo', fields: [], file: wavFile() }),
      ).rejects.toMatchObject({ status: 503 });
    });

    describe('translations gate', () => {
      it('rejects turbo with a 400 — it does not support translation', async () => {
        await expect(
          runTranscription({ kind: 'translations', model: 'whisper-large-v3-turbo', fields: [], file: wavFile() }),
        ).rejects.toMatchObject({ status: 400, message: 'model does not support translation' });
      });

      it('rejects voxtral with a 400 — no translations endpoint', async () => {
        await expect(
          runTranscription({ kind: 'translations', model: 'voxtral-mini-2602', fields: [], file: wavFile() }),
        ).rejects.toMatchObject({ status: 400, message: 'model does not support translation' });
      });

      it('accepts whisper-large-v3 and hits the translations URL', async () => {
        addKey('groq');
        const fetchMock = vi.fn(async () => okGroq('translated text'));
        globalThis.fetch = fetchMock as typeof fetch;

        const result = await runTranscription({
          kind: 'translations',
          model: 'whisper-large-v3',
          fields: [],
          file: wavFile(),
        });
        expect(String(fetchMock.mock.calls[0][0])).toContain('/audio/translations');
        expect(result.status).toBe(200);
      });
    });

    describe('allowlist enforcement', () => {
      it('rejects an explicit model the key cannot reach with 403', async () => {
        await expect(
          runTranscription({
            kind: 'transcriptions',
            model: 'whisper-large-v3-turbo',
            fields: [],
            file: wavFile(),
            clientModelAllowlist: ['groq/whisper-large-v3'],
          }),
        ).rejects.toMatchObject({ status: 403, message: 'no transcription models allowed for this client key' });
      });

      it('rejects with the same 403 when the whole chain is filtered out', async () => {
        await expect(
          runTranscription({
            kind: 'transcriptions',
            model: 'whisper-large-v3-turbo',
            fields: [],
            file: wavFile(),
            clientModelAllowlist: ['mistral/voxtral-mini-2602'],
          }),
        ).rejects.toMatchObject({ status: 403, message: 'no transcription models allowed for this client key' });
      });

      it('dispatches when the requested row IS allowed', async () => {
        addKey('groq');
        globalThis.fetch = vi.fn(async () => okGroq()) as typeof fetch;
        const result = await runTranscription({
          kind: 'transcriptions',
          model: 'whisper-large-v3-turbo',
          fields: [],
          file: wavFile(),
          clientModelAllowlist: ['groq/whisper-large-v3-turbo'],
        });
        expect(result.status).toBe(200);
      });

      it('no allowlist → unrestricted dispatch', async () => {
        addKey('groq');
        globalThis.fetch = vi.fn(async () => okGroq()) as typeof fetch;
        const result = await runTranscription({
          kind: 'transcriptions',
          model: 'whisper-large-v3-turbo',
          fields: [],
          file: wavFile(),
          clientModelAllowlist: null,
        });
        expect(result.status).toBe(200);
      });
    });

    it("logs requests tagged request_type='transcription' with audio_seconds", async () => {
      addKey('groq', 'key-a');
      addKey('groq', 'key-b');
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(okGroq('first try failed, this one works', 42)) as unknown as typeof fetch;

      await runTranscription({ kind: 'transcriptions', model: 'whisper-large-v3-turbo', fields: [], file: wavFile() });
      const rows = getDb().prepare(
        'SELECT platform, status, request_type, audio_seconds FROM requests ORDER BY id',
      ).all() as { platform: string; status: string; request_type: string; audio_seconds: number | null }[];
      expect(rows).toEqual([
        { platform: 'groq', status: 'error', request_type: 'transcription', audio_seconds: null },
        { platform: 'groq', status: 'success', request_type: 'transcription', audio_seconds: 42 },
      ]);

      // chat-scoped monthly usage stays untouched by audio traffic
      const chatUsed = getDb().prepare(`
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
        FROM requests
        WHERE created_at >= datetime('now', 'start of month') AND request_type = 'chat'
      `).get() as { used: number };
      expect(chatUsed.used).toBe(0);
    });

    it('fills input_tokens/output_tokens from mistral usage', async () => {
      addKey('mistral');
      globalThis.fetch = vi.fn(async () => okMistral('ok', 30)) as typeof fetch;

      await runTranscription({ kind: 'transcriptions', model: 'voxtral-mini-2602', fields: [], file: wavFile() });
      const row = getDb().prepare(
        "SELECT input_tokens, output_tokens, audio_seconds FROM requests WHERE status = 'success'",
      ).get() as { input_tokens: number; output_tokens: number; audio_seconds: number };
      expect(row).toEqual({ input_tokens: 5, output_tokens: 3, audio_seconds: 30 });
    });
  });
});
