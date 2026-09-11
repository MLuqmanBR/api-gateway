import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { insertDiscoveredModels } from '../../routes/custom.js';
import type { DiscoveredModel } from '../../providers/base.js';

function row(over: Partial<DiscoveredModel> & { modelId: string }): DiscoveredModel {
  return {
    displayName: over.modelId,
    contextWindow: null,
    supportsVision: false,
    reasoning: false,
    intelligenceScore: null,
    tokensPerSecond: null,
    inputPerM: null,
    outputPerM: null,
    cacheReadPerM: null,
    cacheWritePerM: null,
    ...over,
  };
}

describe('insertDiscoveredModels', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Clear the V32 commandcode seed so counts below are exactly what this
    // suite inserts.
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'commandcode')").run();
    db.prepare("DELETE FROM models WHERE platform = 'commandcode'").run();
  });

  it('inserts scraped rows with ranks, tiers, pricing, telemetry, thinking levels, and fallback entries', () => {
    const rows: DiscoveredModel[] = [
      row({
        modelId: 'deepseek/deepseek-v4.1-flash',
        displayName: 'DeepSeek V4.1 Flash',
        contextWindow: 1048576,
        supportsVision: true,
        reasoning: true,
        intelligenceScore: 41,
        tokensPerSecond: 60,
        inputPerM: 0.15,
        outputPerM: 0.6,
        cacheReadPerM: 0.003,
        cacheWritePerM: null,
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      }),
      row({
        modelId: 'acme/slow-model',
        intelligenceScore: 10,
        tokensPerSecond: 5,
        inputPerM: 0,
        outputPerM: 0,
        cacheWritePerM: 0,
        thinkingLevels: ['off'],
      }),
      row({ modelId: 'acme/unscored-model', displayName: 'Unscored' }),
    ];

    const result = insertDiscoveredModels('commandcode', rows);
    expect(result.fetched).toBe(3);
    expect(result.added).toEqual(['deepseek/deepseek-v4.1-flash', 'acme/slow-model', 'acme/unscored-model']);

    const db = getDb();
    const v41 = db.prepare("SELECT * FROM models WHERE platform = 'commandcode' AND model_id = 'deepseek/deepseek-v4.1-flash'").get() as Record<string, unknown>;
    // score band: 41 → Large; smartest of two scored rows → rank 1
    expect(v41.size_label).toBe('Large');
    expect(v41.intelligence_rank).toBe(1);
    expect(v41.speed_rank).toBe(1);
    expect(v41.supports_vision).toBe(1);
    expect(v41.context_window).toBe(1048576);
    expect(v41.cache_read_per_m).toBeCloseTo(0.003, 6);
    expect(v41.tokens_per_second).toBe(60);
    expect(v41.paid_input_per_m).toBeCloseTo(0.15, 6);
    expect(v41.paid_output_per_m).toBeCloseTo(0.6, 6);
    expect(JSON.parse(v41.thinking_levels as string)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // appended to the fallback chain, enabled
    expect(v41.enabled).toBe(1);
    const fb = db.prepare('SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?').get(v41.id) as { priority: number; enabled: number };
    expect(fb.enabled).toBe(1);
    expect(fb.priority).toBeGreaterThan(0);

    const slow = db.prepare("SELECT * FROM models WHERE model_id = 'acme/slow-model'").get() as Record<string, unknown>;
    expect(slow.size_label).toBe('Small'); // 10 ≤ 12
    expect(slow.intelligence_rank).toBe(2);
    expect(slow.supports_vision).toBe(0);
    expect(slow.paid_input_per_m).toBe(0); // Free → 0, not NULL
    expect(JSON.parse(slow.thinking_levels as string)).toEqual(['off']);

    // unscored row keeps generic defaults, no thinking override
    const unscored = db.prepare("SELECT * FROM models WHERE model_id = 'acme/unscored-model'").get() as Record<string, unknown>;
    expect(unscored.intelligence_rank).toBe(50);
    expect(unscored.speed_rank).toBe(50);
    expect(unscored.size_label).toBe('Custom');
    expect(unscored.cache_read_per_m).toBeNull();

    const fbCount = db.prepare("SELECT count(*) AS c FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id WHERE m.platform = 'commandcode'").get() as { c: number };
    expect(fbCount.c).toBe(3);
  });

  it('is idempotent: a second run adds nothing and keeps ranks stable', () => {
    const rows: DiscoveredModel[] = [
      row({ modelId: 'deepseek/deepseek-v4.1-flash', intelligenceScore: 41, tokensPerSecond: 60 }),
      row({ modelId: 'acme/slow-model', intelligenceScore: 10, tokensPerSecond: 5 }),
      row({ modelId: 'acme/unscored-model', displayName: 'Unscored' }),
    ];
    const second = insertDiscoveredModels('commandcode', rows);
    expect(second.fetched).toBe(0);
    expect(second.added).toEqual([]);

    const count = getDb().prepare("SELECT count(*) AS c FROM models WHERE platform = 'commandcode'").get() as { c: number };
    expect(count.c).toBe(3);
  });

  it('refreshes pricing/telemetry on existing rows but skips operator-set (manual) prices', () => {
    const db = getDb();
    // operator sets a manual price on v4.1-flash
    db.prepare("UPDATE models SET paid_input_per_m = 9.99, pricing_manual = 1 WHERE model_id = 'deepseek/deepseek-v4.1-flash'").run();
    db.prepare("UPDATE models SET thinking_levels = '[\"off\"]', thinking_levels_manual = 1 WHERE model_id = 'deepseek/deepseek-v4.1-flash'").run();

    const rows: DiscoveredModel[] = [
      row({
        modelId: 'deepseek/deepseek-v4.1-flash',
        inputPerM: 0.15,
        outputPerM: 0.6,
        cacheReadPerM: 0.005,
        tokensPerSecond: 99,
        thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      }),
    ];
    insertDiscoveredModels('commandcode', rows);

    const v41 = db.prepare("SELECT * FROM models WHERE model_id = 'deepseek/deepseek-v4.1-flash'").get() as Record<string, unknown>;
    // manual pricing/thinking untouched…
    expect(v41.paid_input_per_m).toBe(9.99);
    expect(JSON.parse(v41.thinking_levels as string)).toEqual(['off']);
    // …telemetry columns (no manual flag) refreshed
    expect(v41.cache_read_per_m).toBeCloseTo(0.005, 6);
    expect(v41.tokens_per_second).toBe(99);

    // restore manual flags for later suites (shared in-memory DB)
    db.prepare("UPDATE models SET paid_input_per_m = 0.15, pricing_manual = 0 WHERE model_id = 'deepseek/deepseek-v4.1-flash'").run();
    db.prepare("UPDATE models SET thinking_levels = '[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"]', thinking_levels_manual = 0 WHERE model_id = 'deepseek/deepseek-v4.1-flash'").run();
  });

  it('skips ids owned by transcription/embedding catalogs', () => {
    const db = getDb();
    // `family` is NOT NULL on transcription_models — omitting it would make
    // INSERT OR IGNORE silently drop the row and fake a pass.
    db.prepare("INSERT OR IGNORE INTO transcription_models (family, platform, model_id, display_name) VALUES ('whisper', 'commandcode', 'acme/whisper-x', 'Whisper X')").run();

    const result = insertDiscoveredModels('commandcode', [row({ modelId: 'acme/whisper-x' })]);
    expect(result.fetched).toBe(0);
    const inChat = db.prepare("SELECT count(*) AS c FROM models WHERE platform = 'commandcode' AND model_id = 'acme/whisper-x'").get() as { c: number };
    expect(inChat.c).toBe(0);
  });
});
