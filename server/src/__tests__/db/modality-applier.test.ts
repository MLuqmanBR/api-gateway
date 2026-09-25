import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { applyModalityIndex } from '../../db/migrations.js';
import { MODALITY_INDEX, modalityIndexKey } from '../../db/modality-index.js';

/**
 * Regression tests for the two things the modality applier must guarantee and
 * that nothing else covered:
 *
 *   1. the ADAPTER CAP — a modality the wire format cannot express is forced
 *      to 0 even when the catalog index (and the heuristic vision rule) claim
 *      the model supports it;
 *   2. OWNERSHIP — a row marked `modalities_manual = 1` is never rewritten.
 *
 * Both are load-bearing: the cap is what stops the router sending audio to
 * Cohere or any media to Cloudflare, and the ownership flag is the only thing
 * separating an operator's edit from a boot-time overwrite.
 */
describe('applyModalityIndex: adapter cap and operator ownership', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  /** Insert a model row and return its id. */
  function seedModel(
    platform: string,
    modelId: string,
    flags: { vision?: number; audio?: number; video?: number; manual?: number } = {},
  ): number {
    const res = getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, monthly_token_budget, context_window, enabled,
        supports_vision, supports_audio_input, supports_video_input, modalities_manual)
      VALUES (?, ?, ?, 50, 50, 'Custom', '', 128000, 1, ?, ?, ?, ?)
    `).run(platform, modelId, modelId,
      flags.vision ?? 1, flags.audio ?? 1, flags.video ?? 1, flags.manual ?? 0);
    return Number(res.lastInsertRowid);
  }

  function flagsOf(id: number): { v: number; a: number; d: number; m: number } {
    const row = getDb().prepare(
      'SELECT supports_vision v, supports_audio_input a, supports_video_input d, modalities_manual m FROM models WHERE id = ?',
    ).get(id) as { v: number; a: number; d: number; m: number };
    return row;
  }

  it('forces every Cloudflare modality to 0 even when the row starts all-ones', () => {
    const id = seedModel('cloudflare', '@cf/test/all-ones');
    applyModalityIndex(getDb(), [id]);
    expect(flagsOf(id)).toMatchObject({ v: 0, a: 0, d: 0 });
  });

  it('forces Cohere audio and video to 0 but leaves image alone', () => {
    const id = seedModel('cohere', 'test-cohere-media');
    applyModalityIndex(getDb(), [id]);
    const flags = flagsOf(id);
    expect(flags.a).toBe(0);
    expect(flags.d).toBe(0);
    // Image is expressible on Cohere (image_url blocks), so the cap must not
    // touch it — a cap that zeroed everything would pass the first two
    // assertions while silently disabling image input.
    expect(flags.v).toBe(1);
  });

  it('forces audio and video to 0 for a custom provider using the anthropic wire format', () => {
    // The cap is resolved from custom_providers.api_format, not a slug list —
    // the live catalog has three such providers (aerolink, freemodelcc,
    // agentroutercc) that a hardcoded list would miss.
    getDb().prepare(
      "INSERT INTO custom_providers (slug, display_name, base_url, api_format) VALUES ('anthtest', 'Anthropic Test', 'https://x.test', 'anthropic')",
    ).run();
    const id = seedModel('anthtest', 'claude-test');
    applyModalityIndex(getDb(), [id]);
    const flags = flagsOf(id);
    expect(flags.a).toBe(0);
    expect(flags.d).toBe(0);
    expect(flags.v).toBe(1);
  });

  it('never rewrites a row the operator owns', () => {
    // Start the row contradicting both the index and the cap, with the
    // ownership flag set: the applier must leave all three flags exactly as-is.
    const id = seedModel('cohere', 'test-operator-owned', { vision: 0, audio: 1, video: 1, manual: 1 });
    const before = flagsOf(id);
    applyModalityIndex(getDb(), [id]);
    expect(flagsOf(id)).toEqual(before);
  });

  it('writes index values (including explicit false) for an owned-but-unflagged row', () => {
    // A row whose flags disagree with the index is CORRECTED, not merely
    // augmented. gemini-2.5-pro is index-covered with all three true, so start
    // it at all-zero and prove the applier RAISES them from the catalog data
    // rather than preserving the stale zeros.
    const row = getDb().prepare(
      "SELECT id FROM models WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'",
    ).get() as { id: number } | undefined;
    expect(row).toBeDefined();
    const indexed = MODALITY_INDEX.get(modalityIndexKey('google', 'gemini-2.5-pro'));
    expect(indexed).toBeDefined();

    getDb().prepare(
      'UPDATE models SET supports_vision = 0, supports_audio_input = 0, supports_video_input = 0, modalities_manual = 0 WHERE id = ?',
    ).run(row!.id);

    applyModalityIndex(getDb(), [row!.id]);

    const flags = flagsOf(row!.id);
    expect(flags.v).toBe(indexed!.image ? 1 : 0);
    expect(flags.a).toBe(indexed!.audio ? 1 : 0);
    expect(flags.d).toBe(indexed!.video ? 1 : 0);
    // All three are true in the index; zeros here would mean the lookup failed.
    expect(flags).toMatchObject({ v: 1, a: 1, d: 1 });
  });

  it('is idempotent: a second scoped pass changes nothing', () => {
    const row = getDb().prepare(
      "SELECT id FROM models WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'",
    ).get() as { id: number } | undefined;
    expect(row).toBeDefined();
    applyModalityIndex(getDb(), [row!.id]);
    const first = flagsOf(row!.id);
    applyModalityIndex(getDb(), [row!.id]);
    expect(flagsOf(row!.id)).toEqual(first);
    expect(first).toMatchObject({ v: 1, a: 1, d: 1 });
  });

  it('retracts an audio flag from a non-chat (ASR) model the index covers with empty flags', () => {
    // Whisper-style models are indexed with an EXPLICIT empty flag set, not
    // omitted. That distinction is load-bearing: an absent key means "no
    // opinion" so a stale audio:true written by an earlier boot would survive
    // forever, while a present-but-empty entry makes the applier write 0. This
    // pins the retraction so removing an entry from the index cannot silently
    // leave the gate advertising a chat capability the model lacks.
    //
    // The row is seeded HERE rather than relying on the catalog: the in-memory
    // test DB does not contain the unorouter rows, and an earlier version of
    // this test had an early `return` guard that made it pass without ever
    // running — a vacuous green.
    const indexed = MODALITY_INDEX.get(modalityIndexKey('unorouter', 'whisper-large-v3-turbo:free'));
    expect(indexed).toBeDefined();
    expect(indexed!.audio).toBeUndefined();

    const id = seedModel('unorouter', 'whisper-large-v3-turbo:free', { vision: 0, audio: 1, video: 0, manual: 0 });
    applyModalityIndex(getDb(), [id]);
    expect(flagsOf(id).a).toBe(0);
  });

  it('treats an all-false index entry as authoritative and clears a stale flag', () => {
    // The general contract behind the ASR case: a PRESENT index entry with
    // empty flags must be able to LOWER a flag, not merely raise one. Used by a
    // catalog-seeded row rather than an aggregator row, so the fixture is
    // stable — an earlier draft depended on an unorouter row the in-memory seed
    // does not contain, which made it pass vacuously.
    const row = getDb().prepare(
      "SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'qwen/qwen3-coder:free'",
    ).get() as { id: number } | undefined;
    expect(row).toBeTruthy(); // fail loudly if the seeded catalog changes

    const indexed = MODALITY_INDEX.get(modalityIndexKey('openrouter', 'qwen/qwen3-coder:free'));
    expect(indexed).toBeDefined();
    // Present but carrying no modality — the shape under test.
    expect(indexed!.image).toBeUndefined();
    expect(indexed!.audio).toBeUndefined();
    expect(indexed!.video).toBeUndefined();

    // Hand-set a stale audio flag exactly as an old boot would have left it.
    getDb().prepare(
      'UPDATE models SET supports_audio_input = 1, modalities_manual = 0 WHERE id = ?',
    ).run(row!.id);

    applyModalityIndex(getDb(), [row!.id]);
    expect(flagsOf(row!.id).a).toBe(0);
  });

  it('leaves rows outside the requested scope untouched', () => {
    const inside = seedModel('cloudflare', '@cf/scoped/inside');
    const outside = seedModel('cloudflare', '@cf/scoped/outside');
    applyModalityIndex(getDb(), [inside]);
    expect(flagsOf(inside)).toMatchObject({ v: 0, a: 0, d: 0 });
    // The out-of-scope row keeps its all-ones start, proving the `id IN (...)`
    // clause is honoured. A scoped helper that quietly ran table-wide would
    // clobber unrelated rows on every model creation.
    expect(flagsOf(outside)).toEqual({ v: 1, a: 1, d: 1, m: 0 });
  });
});
