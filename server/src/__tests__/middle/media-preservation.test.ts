import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { applyOutbound } from '../../middle/index.js';
import { addSecret } from '../../middle/redaction/store.js';
import { isScanned } from '../../middle/redaction/interceptor.js';
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
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // A real secret in the store means redaction is armed and WILL rewrite any
    // text field containing this literal — so a media payload that survives
    // proves the layer excludes media fields rather than merely failing to
    // match them.
    addSecret('SUPERSECRETVALUE', 'api_key', 'manual', 'media-preservation-test');
    setSetting('middle_redaction_enabled', '1');
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

  it('keeps media out of the scanner input so opaque bytes are never scanned', async () => {
    // The interceptor scans messageTEXTS. A media payload is opaque bytes, not
    // prose: scanning it would waste a model call and risk rewriting it. We
    // assert the observable consequence — the interceptor never sees the
    // payload — by checking that a media-only message produces no rewrite and
    // no scanned-text side effect (isScanned stays false for the payload).
    const payload = 'AAAASUPERSECRETVALUE';
    const mediaOnly: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: payload, format: 'wav' } }],
    }];

    await applyOutbound(mediaOnly);

    // The raw payload was never registered as a scanned text target.
    expect(isScanned(payload)).toBe(false);
    // And it is still intact in the message that would be sent upstream.
    expect(JSON.stringify(mediaOnly)).toContain(payload);
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
