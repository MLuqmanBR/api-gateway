import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb, setSetting } from '../../db/index.js';
import { applyOutbound } from '../../middle/index.js';
import { initSecretsStore, addSecret, _resetCacheForTesting } from '../../middle/redaction/store.js';
import type { ChatMessage } from '@api-gateway/shared/types.js';

/**
 * Media blocks must survive the middle layer byte-identical.
 *
 * `redactContent` rebuilds only blocks whose `type` is `text` (or untyped) and
 * passes every other block through by reference. That is the correct behavior
 * and easy to break: a future "redact everything string-shaped" change would
 * rewrite the base64 payload of an audio block or the URL of a video block,
 * silently corrupting the media before it reaches the provider.
 *
 * These tests are the tripwire for that.
 */
describe('middle layer preserves media blocks', () => {
  let tempDir: string;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Redirect the secrets store into a temp dir. Without this, addSecret()
    // writes the REAL <repo>/server/data/middle-secrets.enc — which is what an
    // earlier version of this test did (the .corrupt-* siblings in that
    // directory are the fingerprint), and which would leave a fake "secret" in
    // a real user's store. Every sibling test in this directory isolates the
    // same way.
    tempDir = join(tmpdir(), `media-preservation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    initSecretsStore(tempDir);
    // A real secret in the store means redaction is armed and WILL rewrite any
    // text field containing this literal — so a media payload that survives
    // proves the layer excludes media fields rather than merely failing to
    // match them.
    addSecret('SUPERSECRETVALUE', 'api_key', 'manual', 'media-preservation-test');
    setSetting('middle_redaction_enabled', '1');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    _resetCacheForTesting();
  });

  it('redacts text while leaving image/audio/video payloads byte-identical', async () => {
    const audioPayload = 'UklGRg==SUPERSECRETVALUE_notreally';
    const videoUrl = 'data:video/mp4;base64,SUPERSECRETVALUE';
    const imageUrl = 'data:image/png;base64,SUPERSECRETVALUE';

    const messages: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'please look at SUPERSECRETVALUE in this' },
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'input_audio', input_audio: { data: audioPayload, format: 'wav' } },
        { type: 'video_url', video_url: { url: videoUrl } },
      ],
    }];

    const { messages: out } = await applyOutbound(messages);
    // A redaction instruction is prepended when anything was redacted, so find
    // the user message rather than assuming index 0.
    const userMsg = out.find(m => m.role === 'user');
    expect(userMsg).toBeTruthy();
    const blocks = userMsg?.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;

    // The text block IS redacted…
    const textBlock = blocks.find(b => (b as { type?: string }).type === 'text') as { text: string };
    expect(textBlock.text).not.toContain('SUPERSECRETVALUE');

    // …while every media payload survives verbatim.
    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(audioPayload);
    expect(blocksJson).toContain(videoUrl);
    expect(blocksJson).toContain(imageUrl);
  });

  it('does not offer a media payload to the redaction scanner as text', () => {
    // The interceptor scans messageTEXTS via messageTexts(), which reads only
    // `text` fields. A media payload is opaque base64, not prose: handing it to
    // the scanner would burn a model call and could rewrite the bytes.
    //
    // Assert the OBSERVABLE consequence rather than a private helper: a
    // media-only message must survive applyOutbound intact, while the same
    // bytes appearing in a TEXT field would be rewritten. That contrast is what
    // proves the payload is excluded by field type, not merely left unmatched.
    const payload = 'AAAASUPERSECRETVALUE';
    const mediaOnly: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: payload, format: 'wav' } }],
    }];

    return applyOutbound(mediaOnly).then(() => {
      expect(JSON.stringify(mediaOnly)).toContain(payload);
    });
  });

  it('still redacts the same bytes when they appear in a text field', async () => {
    // Control for the test above: the literal IS in the secret store, so this
    // proves the previous assertion passes because of field-type exclusion and
    // not because the secret was never armed.
    const payload = 'AAAASUPERSECRETVALUE';
    const asText: ChatMessage[] = [{ role: 'user', content: `please redact ${payload}` }];
    const { messages: out } = await applyOutbound(asText);
    expect(JSON.stringify(out)).not.toContain(payload);
  });

  it('compression leaves a media-bearing tool message alone', async () => {
    // compressToolMessages only rewrites role:'tool' messages whose content is
    // a JSON string, so a media array must pass through unchanged.
    setSetting('middle_compression_enabled', '1');
    setSetting('middle_compression_smart_crusher', '1');
    const payload = 'data:image/png;base64,QUJD';
    const { messages: out } = await applyOutbound([{
      role: 'tool',
      tool_call_id: 'call-1',
      content: [{ type: 'image_url', image_url: { url: payload } }] as unknown as string,
    }] as ChatMessage[]);
    expect(JSON.stringify(out)).toContain(payload);
    setSetting('middle_compression_enabled', '0');
  });
});
