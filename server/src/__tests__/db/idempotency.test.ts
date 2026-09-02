import { describe, it, expect } from 'vitest';
import { initDb } from '../../db/index.js';
import { applyTierRules, applyThinkingLevelRules, applyVisionRules, migrateDbSchema } from '../../db/migrations.js';
import { THINKING_LEVELS } from '../../lib/thinking.js';
import { MODEL_PRICING } from '../../db/model-pricing.js';

/**
 * All migrations must be idempotent: running initDb twice on the same
 * physical database file should produce identical state.
 */
describe('Migration idempotency', () => {
  it('initDb on a fresh in-memory DB then re-run produces identical row counts', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // Use a single shared file so both inits hit the same DB.
    const tmpPath = `/tmp/api-gateway-idempotency-${Date.now()}.db`;

    const db1 = initDb(tmpPath);
    const before = {
      models: (db1.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db1.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db1.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db1.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db1.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    };
    db1.close();

    // Re-init the same DB file — V1..V9 should all no-op idempotently.
    const db2 = initDb(tmpPath);
    const after = {
      models: (db2.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db2.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db2.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    };
    db2.close();

    expect(after).toEqual(before);
    expect(after.orphanFallbacks).toBe(0);
  });

  it('every catalog row has exactly one fallback_config entry', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const rows = db.prepare(`
      SELECT m.id, COUNT(f.id) AS fb_count
        FROM models m
        LEFT JOIN fallback_config f ON m.id = f.model_db_id
       GROUP BY m.id
      HAVING COUNT(f.id) <> 1
    `).all() as { id: number; fb_count: number }[];

    expect(rows).toEqual([]);
  });

  it('UNIQUE(platform, model_id) constraint holds — no duplicate catalog rows', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dups = db.prepare(`
      SELECT platform, model_id, COUNT(*) AS c FROM models
       GROUP BY platform, model_id
      HAVING COUNT(*) > 1
    `).all();

    expect(dups).toEqual([]);
  });

  it('V12: dead OR :free rows are absent and the four new rows are present', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dead = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('inclusionai/ling-2.6-1t:free', 'tencent/hy3-preview:free')
    `).all();
    expect(dead).toEqual([]);

    // V21 pruned these three after live probing returned 404 "no endpoints found".
    const pruned = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'arcee-ai/trinity-large-thinking:free',
           'minimax/minimax-m2.5:free',
           'baidu/cobuddy:free'
         )
    `).all();
    expect(pruned).toEqual([]);

    const live = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'openrouter/owl-alpha',
           'nousresearch/hermes-3-llama-3.1-405b:free'
         )
       ORDER BY model_id
    `).all() as { model_id: string }[];
    expect(live.map(r => r.model_id)).toEqual([
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'openrouter/owl-alpha',
    ]);

    const widened = db.prepare(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free')
       ORDER BY model_id
    `).all() as { model_id: string; context_window: number }[];
    expect(widened).toEqual([
      { model_id: 'nvidia/nemotron-3-super-120b-a12b:free', context_window: 1000000 },
      { model_id: 'qwen/qwen3-coder:free', context_window: 1048576 },
    ]);
  });

  it('V13: cross-provider catalog refresh applies cleanly', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Disables — row kept but enabled=0.
    const disabled = db.prepare(`
      SELECT platform, model_id, enabled FROM models
       WHERE (platform = 'google' AND model_id = 'gemini-3.1-pro-preview')
          OR (platform = 'ollama' AND model_id IN ('kimi-k2-thinking', 'mistral-large-3:675b', 'deepseek-v3.2'))
       ORDER BY platform, model_id
    `).all() as { platform: string; model_id: string; enabled: number }[];
    expect(disabled).toHaveLength(4);
    for (const row of disabled) expect(row.enabled).toBe(0);

    // Hard removals — row is gone entirely.
    const removed = db.prepare(`
      SELECT model_id FROM models
       WHERE (platform = 'sambanova' AND model_id = 'DeepSeek-V3.1-cb')
          OR (platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5')
    `).all();
    expect(removed).toEqual([]);

    // New rows present across providers (incl. new huggingface platform).
    const additions = db.prepare(`
      SELECT platform, model_id FROM models
       WHERE (platform, model_id) IN (VALUES
         ('groq',        'openai/gpt-oss-safeguard-20b'),
         ('cloudflare',  '@cf/nvidia/nemotron-3-120b-a12b'),
         ('cloudflare',  '@cf/google/gemma-4-26b-a4b-it'),
         ('google',      'gemini-3.5-flash'),
         ('nvidia',      'deepseek-ai/deepseek-v4-flash'),
         ('nvidia',      'z-ai/glm-5.1'),
         ('nvidia',      'qwen/qwen3-coder-480b-a35b-instruct'),
         ('mistral',     'mistral-small-latest'),
         ('mistral',     'ministral-8b-latest'),
         ('cohere',      'command-a-reasoning-08-2025'),
         ('cohere',      'command-r-08-2024'),
         ('ollama',      'qwen3-coder-next'),
         ('huggingface', 'deepseek-ai/DeepSeek-V4-Flash'),
         ('huggingface', 'moonshotai/Kimi-K2.6'),
         ('huggingface', 'Qwen/Qwen3-Coder-Next')
       )
    `).all();
    expect(additions).toHaveLength(15);

    // Spot-check critical limit/context updates.
    const cerebrasLimits = db.prepare(`
      SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM models
       WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'
    `).get() as { rpm_limit: number; rpd_limit: number; tpm_limit: number; tpd_limit: number };
    expect(cerebrasLimits).toEqual({ rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000 });

    const cfFp8Ctx = (db.prepare(`
      SELECT context_window FROM models WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    `).get() as { context_window: number }).context_window;
    expect(cfFp8Ctx).toBe(24000);

    const mistralCtx = db.prepare(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'mistral'
         AND model_id IN ('codestral-latest', 'devstral-latest', 'magistral-medium-latest', 'mistral-large-latest')
       ORDER BY model_id
    `).all() as { model_id: string; context_window: number }[];
    expect(mistralCtx).toEqual([
      { model_id: 'codestral-latest',       context_window: 256000 },
      { model_id: 'devstral-latest',        context_window: 262144 },
      { model_id: 'magistral-medium-latest', context_window: 131072 },
      { model_id: 'mistral-large-latest',   context_window: 262144 },
    ]);
  });

  it('V14: cerebras deprecation disables qwen-3-235b and llama3.1-8b but keeps gpt-oss-120b enabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const rows = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'cerebras'
         AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b', 'gpt-oss-120b')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];

    expect(rows).toEqual([
      { model_id: 'gpt-oss-120b',                    enabled: 1 },
      { model_id: 'llama3.1-8b',                     enabled: 0 },
      { model_id: 'qwen-3-235b-a22b-instruct-2507',  enabled: 0 },
    ]);
  });

  it('V23: sambanova/chutes are gone; live-verified free additions are present with the right flags', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Platform drops — no model, fallback, or key rows survive.
    const deadRows = db.prepare(
      `SELECT COUNT(*) AS n FROM models WHERE platform IN ('sambanova', 'chutes')`
    ).get() as { n: number };
    expect(deadRows.n).toBe(0);
    const deadKeys = db.prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE platform IN ('sambanova', 'chutes')`
    ).get() as { n: number };
    expect(deadKeys.n).toBe(0);

    // Additions, with the flags the live probe verified (vision comes
    // from the V16 rule, so it must hold on a fresh seed too).
    const added = db.prepare(`
      SELECT platform, model_id, enabled, supports_vision FROM models
       WHERE (platform = 'openrouter' AND model_id IN (
               'moonshotai/kimi-k2.6:free',
               'nvidia/nemotron-3-ultra-550b-a55b:free',
               'nvidia/nemotron-nano-12b-v2-vl:free',
               'meta-llama/llama-3.2-3b-instruct:free',
               'cognitivecomputations/dolphin-mistral-24b-venice-edition:free'))
          OR (platform = 'zhipu' AND model_id = 'glm-4.6v-flash')
       ORDER BY platform, model_id
    `).all() as { model_id: string; enabled: number; supports_vision: number }[];
    expect(added.map(r => [r.model_id, r.enabled, r.supports_vision])).toEqual([
      ['cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 1, 0],
      ['meta-llama/llama-3.2-3b-instruct:free',                         1, 0],
      ['moonshotai/kimi-k2.6:free',                                     1, 0],
      ['nvidia/nemotron-3-ultra-550b-a55b:free',                        0, 0], // hangs 180s+; seeded disabled
      ['nvidia/nemotron-nano-12b-v2-vl:free',                           1, 1],
      ['glm-4.6v-flash',                                                1, 1],
    ]);
  });

  it('V24: Zen roster refresh lands and the hung NIM gemma is paused', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const zen = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-ultra-free', 'minimax-m3-free')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];
    expect(zen.map(r => [r.model_id, r.enabled])).toEqual([
      // minimax-m3-free was seeded enabled here in V24, then retired in V25 when
      // its free promo ended (now enabled=0). nemotron-3-ultra-free is still live.
      ['minimax-m3-free',       0],
      ['nemotron-3-ultra-free', 1],
    ]);

    // The hung NIM gemma route is paused (row kept, enabled=0, re-asserted
    // each boot like the V13 disables).
    const gemma = db.prepare(`
      SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = 'google/gemma-4-31b-it'
    `).get() as { enabled: number };
    expect(gemma.enabled).toBe(0);
  });

  it('V25: dead OpenCode Zen free promos (nemotron-3-super-free, minimax-m3-free) are disabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dead = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];
    expect(dead.map(r => [r.model_id, r.enabled])).toEqual([
      ['minimax-m3-free',       0],
      ['nemotron-3-super-free', 0],
    ]);
  });

  it('all enabled catalog platforms have a registered provider', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');
    const { hasProvider } = await import('../../providers/index.js');

    const platforms = (db.prepare(
      `SELECT DISTINCT platform FROM models WHERE enabled = 1`
    ).all() as { platform: any }[]).map(r => r.platform);

    const missing = platforms.filter(p => !hasProvider(p));
    expect(missing).toEqual([]);
  });

  it('catalog rules seed fresh families but never revisit operator-edited rows', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpPath = `/tmp/api-gateway-rules-${Date.now()}.db`;
    const db = initDb(tmpPath);

    // Seeded families are flagged/tiered by the one-time rule pass.
    const gemini = db.prepare(
      "SELECT id, supports_vision FROM models WHERE platform = 'google' LIMIT 1",
    ).get() as { id: number; supports_vision: number };
    expect(gemini.supports_vision).toBe(1);

    // Scoping guard: a scoped helper call touches ONLY the given ids.
    // The manual row below matches an EARLIER OR branch of its rule chain
    // than the appended id-IN clause — SQL precedence bugs would clobber it.
    const glm = db.prepare(
      "SELECT id FROM models WHERE LOWER(model_id) LIKE '%glm-4.6v%' LIMIT 1",
    ).get() as { id: number };
    db.prepare('UPDATE models SET supports_vision = 0 WHERE id IN (?, ?)').run(glm.id, gemini.id);
    const ins = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('google', 'gemini-9.9-test', 'Gemini 9.9 Test', 10, 10, '', 1)
    `).run();
    const newId = Number(ins.lastInsertRowid);
    applyVisionRules(db, [newId]);
    expect((db.prepare('SELECT supports_vision AS v FROM models WHERE id = ?').get(newId) as { v: number }).v).toBe(1);
    expect((db.prepare('SELECT supports_vision AS v FROM models WHERE id = ?').get(gemini.id) as { v: number }).v).toBe(0);
    expect((db.prepare('SELECT supports_vision AS v FROM models WHERE id = ?').get(glm.id) as { v: number }).v).toBe(0);

    // Restart path: migrateDbSchema re-run (one-time block skipped at
    // user_version = CURRENT_DATA_VERSION) must not touch operator edits.
    const tiered = db.prepare(
      "SELECT id FROM models WHERE LOWER(model_id) LIKE '%llama-3.3-70b%' LIMIT 1",
    ).get() as { id: number };
    db.prepare("UPDATE models SET size_label = 'Small' WHERE id = ?").run(tiered.id);
    migrateDbSchema(db);
    expect((db.prepare('SELECT supports_vision AS v FROM models WHERE id = ?').get(gemini.id) as { v: number }).v).toBe(0);
    expect((db.prepare('SELECT size_label AS s FROM models WHERE id = ?').get(tiered.id) as { s: string }).s).toBe('Small');
    // ...while a scoped tier pass still flags brand-new rows.
    const ins2 = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES ('groq', 'llama-3.3-70b-versatile-new', 'Llama New', 10, 10, '', 1)
    `).run();
    const newTierId = Number(ins2.lastInsertRowid);
    applyTierRules(db, [newTierId]);
    expect((db.prepare('SELECT size_label AS s FROM models WHERE id = ?').get(newTierId) as { s: string }).s).toBe('Medium');
    // llama-3.3-70b sits in an EARLIER Medium OR branch than the appended
    // id-IN clause — precedence would revert it to 'Medium' if unscoped.
    expect((db.prepare('SELECT size_label AS s FROM models WHERE id = ?').get(tiered.id) as { s: string }).s).toBe('Small');
    db.close();
  });

  it('thinking levels: boot pass seeds glm_mapped rows and never revisits operator-owned ones', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpPath = `/tmp/api-gateway-thinking-${Date.now()}.db`;
    const db = initDb(tmpPath);
    const DEFAULT = JSON.stringify([...THINKING_LEVELS]);
    const GLM = JSON.stringify(['low', 'medium', 'high']);
    // Named row shapes (unchecked casts): the SELECT aliases are fixed by the
    // SQL below, not external input.
    type LevelRow = { l: string };
    type FlagRow = { m: number };
    const levelsOf = (id: number): string => {
      const row = db.prepare('SELECT thinking_levels AS l FROM models WHERE id = ?').get(id) as LevelRow | undefined;
      return row?.l ?? '';
    };
    const manualFlag = (id: number): number => {
      const row = db.prepare('SELECT thinking_levels_manual AS m FROM models WHERE id = ?').get(id) as FlagRow | undefined;
      return row?.m ?? -1;
    };

    const ins = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES (?, ?, ?, 10, 10, '', 1)
    `);
    // Host-based rule match (GLM_HOST_PLATFORMS) and id-based (isGlmModel).
    const hostRow = Number(ins.run('glmaggregatorb', 'glm-test-host', 'Host Row').lastInsertRowid);
    const idRow = Number(ins.run('some-platform', 'z-ai/glm-5.1', 'Id Row').lastInsertRowid);
    const otherRow = Number(ins.run('openrouter', 'deepseek-v4-pro', 'Other').lastInsertRowid);

    // glm-mapped rows get the narrow set, everything else stays at default.
    applyThinkingLevelRules(db, [hostRow, idRow, otherRow]);
    expect(levelsOf(hostRow)).toBe(GLM);
    expect(levelsOf(idRow)).toBe(GLM);
    expect(levelsOf(otherRow)).toBe(DEFAULT);

    // (a) operator-edited row survives reboots untouched.
    db.prepare("UPDATE models SET thinking_levels = ?, thinking_levels_manual = 1 WHERE id = ?").run(JSON.stringify(['high']), hostRow);
    // (b) operator deliberately resetting to all-six keeps it after reboot —
    // the manual flag, not the value, decides ownership.
    db.prepare("UPDATE models SET thinking_levels = ?, thinking_levels_manual = 1 WHERE id = ?").run(DEFAULT, idRow);
    migrateDbSchema(db);
    expect(levelsOf(hostRow)).toBe(JSON.stringify(['high']));
    expect(levelsOf(idRow)).toBe(DEFAULT);
    expect(manualFlag(hostRow)).toBe(1);
    expect(manualFlag(idRow)).toBe(1);

    // (c) a still-default glm_mapped row IS seeded by the next boot pass,
    // with the manual flag left at 0 so operators can still claim it later.
    const freshRow = Number(ins.run('glmaggregatorb', 'glm-fresh-row', 'Fresh').lastInsertRowid);
    expect(levelsOf(freshRow)).toBe(DEFAULT);
    migrateDbSchema(db);
    expect(levelsOf(freshRow)).toBe(GLM);
    expect(manualFlag(freshRow)).toBe(0);

    // Discovery path: runtime ingest scopes the rule to newly inserted ids
    // so late-synced models don't wait for a reboot.
    const lateRow = Number(ins.run('some-platform', 'zai-org/glm_5_2-x', 'Late').lastInsertRowid);
    applyThinkingLevelRules(db, [lateRow]);
    expect(levelsOf(lateRow)).toBe(GLM);
    expect(manualFlag(lateRow)).toBe(0);
    db.close();
  });

  it('applyModelPricing refreshes mapped prices but respects pricing_manual', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpPath = `/tmp/api-gateway-pricing-${Date.now()}.db`;
    const db = initDb(tmpPath);

    const [pPlatform, pModelId, pIn, pOut] = MODEL_PRICING[0];
    const marked = db.prepare(
      'SELECT id FROM models WHERE platform = ? AND model_id = ?',
    ).get(pPlatform, pModelId) as { id: number };
    db.prepare('UPDATE models SET paid_input_per_m = 9.99, pricing_manual = 1 WHERE id = ?').run(marked.id);

    const other = MODEL_PRICING.find(([pl, mid]) => !(pl === pPlatform && mid === pModelId) && pl === pPlatform)!;
    const unmarked = db.prepare(
      'SELECT id, paid_input_per_m FROM models WHERE platform = ? AND model_id = ?',
    ).get(other[0], other[1]) as { id: number; paid_input_per_m: number | null };

    migrateDbSchema(db);
    expect((db.prepare('SELECT paid_input_per_m AS p FROM models WHERE id = ?').get(marked.id) as { p: number }).p).toBe(9.99);
    expect((db.prepare('SELECT paid_input_per_m AS p FROM models WHERE id = ?').get(unmarked.id) as { p: number }).p).toBe(other[2]);
    db.close();
  });
  it('transcription_models: seeds are stable, UNIQUE holds, audio_seconds column present after both inits', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const tmpPath = `/tmp/api-gateway-transcription-idem-${Date.now()}.db`;

    const db1 = initDb(tmpPath);
    const before = {
      rows: (db1.prepare('SELECT COUNT(*) AS c FROM transcription_models').get() as { c: number }).c,
      dups: (db1.prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT platform, model_id FROM transcription_models
           GROUP BY platform, model_id HAVING COUNT(*) > 1
        )
      `).get() as { c: number }).c,
      defaultFamily: (db1.prepare("SELECT value FROM settings WHERE key = 'transcriptions_default_family'").get() as { value: string }).value,
    };
    const cols1 = (db1.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map(c => c.name);
    db1.close();

    const db2 = initDb(tmpPath);
    const after = {
      rows: (db2.prepare('SELECT COUNT(*) AS c FROM transcription_models').get() as { c: number }).c,
      dups: (db2.prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT platform, model_id FROM transcription_models
           GROUP BY platform, model_id HAVING COUNT(*) > 1
        )
      `).get() as { c: number }).c,
      defaultFamily: (db2.prepare("SELECT value FROM settings WHERE key = 'transcriptions_default_family'").get() as { value: string }).value,
    };
    const cols2 = (db2.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map(c => c.name);
    db2.close();

    expect(after).toEqual(before);
    expect(after.rows).toBe(3);
    expect(after.dups).toBe(0);
    expect(after.defaultFamily).toBe('whisper-large-v3-turbo');
    expect(cols1).toContain('audio_seconds');
    expect(cols2).toContain('audio_seconds');
  });
  it('reconcileCatalogRowsOutOfChat: catalog-owned pairs cannot live in chat models, idempotently', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Catalog tables (transcription_models, embedding_models) own their ids:
    // any chat-model row for a cataloged pair is a resurrection (discovery,
    // manual add, old config import) and boot reconciliation deletes it.
    // Recreate that state: chat models row + fallback row for one pair from
    // each catalog. The nvidia pair is in the V1 embedding seed; the ovh pair
    // (public upstream built-in) needs a seeded transcription row.
    const insertModel = db.prepare(
      'INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank) VALUES (?, ?, ?, 1, 1)',
    );
    const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    const pairs: Array<[string, string]> = [
      ['nvidia', 'nvidia/nv-embedqa-e5-v5'],
      ['ovh', 'whisper-large-v3'],
    ];
    db.prepare(
      `INSERT INTO transcription_models
         (family, platform, model_id, display_name, max_file_mb, supports_translations, price_per_hour_usd, priority, enabled, quota_label)
       VALUES ('whisper-large-v3', 'ovh', 'whisper-large-v3', 'Whisper Large V3 (OVH)', 25, 0, NULL, 2, 1, '')`,
    ).run();
    const modelsBefore = (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c;
    for (const [platform, modelId] of pairs) {
      const info = insertModel.run(platform, modelId, modelId);
      insertFallback.run(Number(info.lastInsertRowid), 1);
    }

    // Re-run the full migration on the already-initialized DB.
    migrateDbSchema(db);

    // Catalog-owned pairs left the chat catalog…
    for (const [platform, modelId] of pairs) {
      expect(
        (db.prepare('SELECT COUNT(*) AS c FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { c: number }).c,
      ).toBe(0);
    }
    expect((db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c).toBe(modelsBefore);
    // …no orphaned fallback rows were left behind…
    expect((db.prepare(`
      SELECT COUNT(*) AS c FROM fallback_config f
      LEFT JOIN models m ON f.model_db_id = m.id
      WHERE m.id IS NULL
    `).get() as { c: number }).c).toBe(0);
    // …catalog rows survive untouched (3 V1 transcription + 1 seeded, 12 V1 embeddings)…
    expect((db.prepare('SELECT COUNT(*) AS c FROM transcription_models').get() as { c: number }).c).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS c FROM embedding_models').get() as { c: number }).c).toBe(12);
    expect((db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT platform, model_id FROM transcription_models
         GROUP BY platform, model_id HAVING COUNT(*) > 1
      )
    `).get() as { c: number }).c).toBe(0);

    // Second re-run: stable (DELETEs find nothing; counts identical).
    migrateDbSchema(db);
    expect((db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c).toBe(modelsBefore);
    expect((db.prepare('SELECT COUNT(*) AS c FROM transcription_models').get() as { c: number }).c).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS c FROM embedding_models').get() as { c: number }).c).toBe(12);

    db.close();
  });
});
