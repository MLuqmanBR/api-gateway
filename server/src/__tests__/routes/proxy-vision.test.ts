import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

const IMAGE_MESSAGE = {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }],
};

describe('Vision-aware routing (#118, #125)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('seeds supports_vision: true for vision models, false for text-only', () => {
    const db = getDb();
    const vision = db.prepare("SELECT supports_vision FROM models WHERE model_id = 'gemini-2.5-flash'").get() as { supports_vision: number };
    expect(vision.supports_vision).toBe(1);

    // The known vision set is flagged; plenty of text-only models remain at 0.
    const visionCount = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_vision = 1').get() as { c: number }).c;
    const textCount = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_vision = 0').get() as { c: number }).c;
    expect(visionCount).toBeGreaterThanOrEqual(4);
    expect(textCount).toBeGreaterThan(0);
  });

  it('lets an image request through routing when a vision model is enabled (no 422)', async () => {
    // Seed has Gemini/Llama-4 vision models enabled but no provider keys, so
    // routing exhausts → 429. The point: it is NOT the 422 "no vision model"
    // error, proving the precheck passed and routing was attempted.
    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
  });

  it('rejects an image request with a clear 422 when no vision model is enabled', async () => {
    // Disable every vision-capable model in the chain.
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_vision = 1').run();

    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_vision_model');
    expect(body.error.type).toBe('invalid_request_error');

    // Restore so we don't leak state to other expectations.
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_vision = 1').run();
  });

  it('does not apply the vision gate to a text-only request', async () => {
    // Disable all vision models; a plain text request must still route normally
    // (it 429s on exhaustion here, but never the 422 vision error).
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_vision = 1').run();
    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_vision = 1').run();
  });
});

// The modality index gives real per-model audio/video data, so the same
// precheck that gated images now gates those too — each with its own code.
describe('Modality-aware routing (audio + video)', () => {
  let app: Express;
  let key: string;

  const AUDIO_MESSAGE = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'transcribe this' },
        { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
      ],
    }],
  };
  const VIDEO_MESSAGE = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what happens here?' },
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
      ],
    }],
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('the index flags audio- and video-capable models', () => {
    const db = getDb();
    const audio = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_audio_input = 1').get() as { c: number }).c;
    const video = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_video_input = 1').get() as { c: number }).c;
    expect(audio).toBeGreaterThan(0);
    expect(video).toBeGreaterThan(0);
    // Gemini accepts all three — a concrete end-to-end assertion that the
    // index reached a real seeded model rather than only aggregate counts.
    const gemini = db.prepare(
      "SELECT supports_vision v, supports_audio_input a, supports_video_input d FROM models WHERE model_id = 'gemini-2.5-flash'",
    ).get() as { v: number; a: number; d: number };
    expect(gemini).toEqual({ v: 1, a: 1, d: 1 });
  });

  it('routes an audio request when an audio-capable model is enabled', async () => {
    const { status, body } = await post(app, '/v1/chat/completions', AUDIO_MESSAGE, key);
    // No provider keys seeded: routing exhausts (429). The point is that the
    // modality precheck passed rather than rejecting up front.
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_audio_model');
  });

  it('rejects an audio request with no_audio_model when none is enabled', async () => {
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_audio_input = 1').run();
    const { status, body } = await post(app, '/v1/chat/completions', AUDIO_MESSAGE, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_audio_model');
    expect(body.error.type).toBe('invalid_request_error');
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_audio_input = 1').run();
  });

  it('rejects a video request with no_video_model when none is enabled', async () => {
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_video_input = 1').run();
    const { status, body } = await post(app, '/v1/chat/completions', VIDEO_MESSAGE, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_video_model');
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_video_input = 1').run();
  });

  it('rejects a CHAIN-DISABLED pinned model instead of silently rerouting', async () => {
    // The bug this pins (reproduced live before the fix): a pin resolves against
    // `models.enabled = 1` (lib/pinned-model.ts) but the routing chain is built
    // from `fallback_config ... WHERE fc.enabled = 1`. A model enabled in the
    // catalog but absent from the chain resolved as a pin and then routed
    // ANYWHERE — measured live as HTTP 200 from a different model:
    //   pin=logfare/deepseek-v4-pro-0813 (models.enabled=1, fc.enabled=0)
    //   -> HTTP 200, X-Routed-Via: logfare/qwen-3.8-27b
    //
    // A pin names a specific model; another model's answer is not a substitute.
    // Now a 400 model_not_routable, from routeRequest, checked against the
    // actual built chain so it cannot disagree with what is routable.
    const db = getDb();
    const anyTextOnly = db.prepare(
      'SELECT id, platform, model_id FROM models WHERE supports_vision = 0 LIMIT 1',
    ).get() as { id: number; platform: string; model_id: string } | undefined;
    expect(anyTextOnly).toBeTruthy();

    // Catalog-enabled, chain-disabled: exactly the gap.
    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(anyTextOnly!.id);

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: `${anyTextOnly!.platform}/${anyTextOnly!.model_id}`,
      messages: [{ role: 'user', content: 'hello' }],
    }, key);

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_routable');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/not in the enabled fallback chain/i);
  });

  it('still routes a pin that IS in the enabled chain', async () => {
    // The guard must not reject legitimate pins. Re-enable the row the previous
    // test disabled and confirm the same pin now routes.
    const db = getDb();
    const row = db.prepare(
      'SELECT m.id, m.platform, m.model_id FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id LIMIT 1',
    ).get() as { id: number; platform: string; model_id: string } | undefined;
    expect(row).toBeTruthy();
    db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(row!.id);

    const { status, body } = await post(app, '/v1/chat/completions', {
      model: `${row!.platform}/${row!.model_id}`,
      messages: [{ role: 'user', content: 'hello' }],
    }, key);

    // Not a pin rejection. (Status may be 200 or an exhaustion status — this DB
    // has no provider keys — but never the not-routable error.)
    expect(body?.error?.code).not.toBe('model_not_routable');
    expect(status).not.toBe(400);
  });

  it('leaves a text-only request untouched by the modality gate', async () => {
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_audio_input = 1 OR supports_video_input = 1').run();
    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_audio_model');
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_audio_input = 1 OR supports_video_input = 1').run();
  });

  it('fails a PINNED CHAIN-ENABLED model that cannot express the modality instead of silently rerouting', async () => {
    // SCOPE — read this before trusting the guarantee: the mismatch is only
    // detected for a pin that is IN the enabled fallback chain.
    //
    // ModalityMismatchError is raised inside the chain loop, guarded by
    // `pinMode && preferredModelDbId === entry.model_db_id` (router.ts:706), so
    // it can only fire for a model the loop actually visits. A pin that
    // resolves (lib/pinned-model.ts accepts any `models.enabled = 1` row) but
    // is absent from the chain is never visited, so it silently routes
    // elsewhere — see proxy-pinned-model.test.ts for the documented gap and
    // local://pin-fallthrough-bug.md for the underlying bug, which is
    // pre-existing and unrelated to modality routing.
    //
    // The fixture therefore selects a CHAIN-ENABLED text-only row. Selecting on
    // `models.enabled = 1` alone (as an earlier revision did) can pick a
    // chain-disabled row, in which case this test passes for the wrong reason.
    const db = getDb();
    // Chain membership is in the JOIN CONDITION, not a WHERE filter, so the
    // requirement cannot be accidentally relaxed by a later edit to the WHERE
    // clause — this test is only valid for a row the router will actually visit.
    const textOnly = db.prepare(`
      SELECT m.id, m.platform, m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id AND fc.enabled = 1
      WHERE m.supports_vision = 0 AND m.enabled = 1
      LIMIT 1
    `).get() as { id: number; platform: string; model_id: string } | undefined;
    expect(textOnly).toBeTruthy();

    // Pin as `platform/model_id`: a bare id is deliberately rejected as
    // ambiguous (400 model_not_found) when it matches rows on several
    // platforms, which would mask the capability check under test.
    const { status, body } = await post(app, '/v1/chat/completions', {
      model: `${textOnly.platform}/${textOnly.model_id}`,
      messages: IMAGE_MESSAGE.messages,
    }, key);

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_capability_mismatch');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain(textOnly!.model_id);
  });
});
