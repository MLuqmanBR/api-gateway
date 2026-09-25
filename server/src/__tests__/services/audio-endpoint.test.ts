import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { resolveAudioEndpoint } from '../../services/transcriptions.js';

/**
 * The batch audio pipeline resolves its endpoint as `${baseUrl}/audio/<kind>`.
 *
 * That is only correct if every provider base URL already carries its version
 * segment — chat needs it too, so `normalizeOpenAiBaseUrl` guarantees it at
 * every write site. This suite pins the URLs for the platforms that have live
 * transcription catalog rows, so a future base-URL edit cannot silently break
 * audio without failing here.
 */
describe('audio endpoint resolution', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  const EXPECTED: Record<string, string> = {
    // Built-ins with a hardcoded base URL.
    groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
    mistral: 'https://api.mistral.ai/v1/audio/transcriptions',
    openrouter: 'https://openrouter.ai/api/v1/audio/transcriptions',
    ovh: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
  };

  it.each(Object.entries(EXPECTED))('resolves %s to its documented endpoint', (platform, expected) => {
    expect(resolveAudioEndpoint(platform, 'transcriptions')).toBe(expected);
  });

  it('switches the path segment for translations', () => {
    expect(resolveAudioEndpoint('groq', 'translations')).toBe('https://api.groq.com/openai/v1/audio/translations');
  });

  it('uses a custom provider base URL verbatim, including its /v1', () => {
    getDb().prepare(
      `INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('audiotest', 'Audio Test', 'https://audio.example.com/v1')`,
    ).run();
    expect(resolveAudioEndpoint('audiotest', 'transcriptions'))
      .toBe('https://audio.example.com/v1/audio/transcriptions');
  });

  it('strips a trailing slash rather than producing a double slash', () => {
    getDb().prepare(
      `INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('audioslash', 'Slash Test', 'https://slash.example.com/v1/')`,
    ).run();
    expect(resolveAudioEndpoint('audioslash', 'transcriptions'))
      .toBe('https://slash.example.com/v1/audio/transcriptions');
  });

  it('returns null for an unknown platform instead of inventing a URL', () => {
    // A row with no resolvable base URL must fail with a clear message rather
    // than guessing an endpoint and getting an opaque 404 from a wrong host.
    expect(resolveAudioEndpoint('no-such-platform-xyz', 'transcriptions')).toBeNull();
  });
});
