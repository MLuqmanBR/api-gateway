// Tests for the F3/F4/F8 backup-restore sections of the config importer
// (server/src/lib/config/import.ts): client_keys, budgets, webhooks, plus
// the transcription_models / embedding_models catalogs (round-trip below).
//
// These drive runImport()/previewEnvelope() directly against an in-memory
// database. The centerpiece is IDEMPOTENCY: importing the SAME envelope
// twice must yield zero duplicates in every merge mode (the historical
// duplication bug this suite exists to prevent).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { runImport, previewEnvelope, probeKeyCompatibility } from '../../lib/config/import.js';
import type { ConfigEnvelope } from '@api-gateway/shared';

const HASH = 'a'.repeat(64);
const SALT = 'b'.repeat(32);

function baseEnvelope(): ConfigEnvelope {
  return {
    schemaVersion: 1,
    generator: 'api-gateway',
    exportedAt: new Date().toISOString(),
    sections: {
      clientKeys: [
        {
          id: 'ck_aaa', secretHash: HASH, salt: SALT, label: 'CI', enabled: true,
          expiresAtMs: null, modelAllowlist: ['gpt-4o', 'custom-model/x'], rpmOverride: null,
          createdAtMs: 1700000000000,
        },
        {
          id: 'ck_bbb', secretHash: HASH, salt: SALT, label: 'Disabled key', enabled: false,
          createdAtMs: 1700000001000,
        },
      ],
      budgets: [
        { scope: 'client_key', scopeId: 'ck_aaa', dailyLimitCents: 500, weeklyLimitCents: null,
          monthlyLimitCents: 2500, weeklyResetDay: 3 },
        // No scopeId at all — must land as (global, NULL).
        { scope: 'global', monthlyLimitCents: 10000 },
      ],
      webhooks: [
        { url: 'https://hooks.example.test/a', secret: 's3cret-a', eventsFilter: 'routing.*',
          enabled: true, createdAtMs: 1700000002000 },
        { url: 'https://hooks.example.test/b', secret: 's3cret-b', eventsFilter: '*',
          enabled: false },
      ],
    },
  };
}

function wipe(): void {
  const db = getDb();
  db.prepare('DELETE FROM budgets').run();
  db.prepare('DELETE FROM client_keys').run();
  db.prepare('DELETE FROM webhooks').run();
}

function count(table: string, where = ''): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n;
}

describe('config import backup sections (client_keys / budgets / webhooks)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(wipe);

  it('previewEnvelope inventories the new sections when present', () => {
    const p = previewEnvelope(baseEnvelope());
    expect(p.sections.client_keys).toBe(2);
    expect(p.sections.budgets).toBe(2);
    expect(p.sections.webhooks).toBe(2);
  });

  for (const mode of ['skip-existing', 'overwrite', 'replace'] as const) {
    it(`mode=${mode}: importing the same envelope twice yields zero duplicates`, () => {
      const env = baseEnvelope();
      const first = runImport({ envelope: structuredClone(env), options: { mode, dryRun: false } });
      expect(first.sections.client_keys?.errors ?? []).toEqual([]);
      expect(first.sections.budgets?.errors ?? []).toEqual([]);
      expect(first.sections.webhooks?.errors ?? []).toEqual([]);
      expect(count('client_keys')).toBe(2);
      expect(count('budgets')).toBe(2);
      expect(count('webhooks')).toBe(2);

      const second = runImport({ envelope: structuredClone(env), options: { mode, dryRun: false } });
      expect(second.sections.client_keys?.errors ?? []).toEqual([]);
      expect(second.sections.budgets?.errors ?? []).toEqual([]);
      expect(second.sections.webhooks?.errors ?? []).toEqual([]);
      // Zero duplicates — the table counts are unchanged.
      expect(count('client_keys')).toBe(2);
      expect(count('budgets')).toBe(2);
      expect(count('webhooks')).toBe(2);
      if (mode === 'replace') {
        // Wipe-and-reinsert: everything counts as added again, but the ids/
        // urls are preserved so nothing accumulates.
        expect(second.sections.client_keys?.added).toBe(2);
        expect(getDb().prepare("SELECT id FROM client_keys WHERE id='ck_aaa'").get()).toBeDefined();
      } else {
        // No-op re-import: every row lands as skipped, nothing written.
        expect(second.sections.client_keys?.added).toBe(0);
        expect(second.sections.client_keys?.updated).toBe(0);
        expect(second.sections.budgets?.added).toBe(0);
        expect(second.sections.budgets?.updated).toBe(0);
        expect(second.sections.webhooks?.added).toBe(0);
        expect(second.sections.webhooks?.updated).toBe(0);
      }
    });
  }

  it('restores row values verbatim with fresh usage counters', () => {
    runImport({ envelope: baseEnvelope(), options: { mode: 'overwrite', dryRun: false } });
    const db = getDb();

    const ckA = db.prepare("SELECT * FROM client_keys WHERE id = 'ck_aaa'").get() as Record<string, unknown>;
    expect(ckA.model_allowlist).toBe(JSON.stringify(['gpt-4o', 'custom-model/x']));
    expect(ckA.enabled).toBe(1);
    expect(ckA.created_at_ms).toBe(1700000000000);
    expect(ckA.expires_at_ms).toBeNull();

    const ckB = db.prepare("SELECT * FROM client_keys WHERE id = 'ck_bbb'").get() as Record<string, unknown>;
    expect(ckB.enabled).toBe(0);
    expect(ckB.model_allowlist).toBeNull();

    const bKey = db.prepare("SELECT * FROM budgets WHERE scope = 'client_key'").get() as Record<string, unknown>;
    expect(bKey.scope_id).toBe('ck_aaa');
    expect(bKey.daily_limit_cents).toBe(500);
    expect(bKey.weekly_limit_cents).toBeNull();
    expect(bKey.monthly_limit_cents).toBe(2500);
    expect(bKey.weekly_reset_day).toBe(3);
    // Runtime state starts fresh — lazy reset recomputes windows.
    expect(bKey.daily_used_cents).toBe(0);
    expect(bKey.monthly_used_cents).toBe(0);
    expect(bKey.weekly_reset_at).toBeNull();

    const bGlobal = db.prepare('SELECT * FROM budgets WHERE scope_id IS NULL').get() as Record<string, unknown>;
    expect(bGlobal.scope).toBe('global');
    expect(bGlobal.monthly_limit_cents).toBe(10000);
    expect(bGlobal.weekly_reset_day).toBe(1); // column default semantics

    const wA = db.prepare("SELECT * FROM webhooks WHERE url = 'https://hooks.example.test/a'").get() as Record<string, unknown>;
    expect(wA.secret).toBe('s3cret-a');
    expect(wA.events_filter).toBe('routing.*');
    expect(wA.enabled).toBe(1);
    expect(wA.created_at).toBe(1700000002000);

    const wB = db.prepare("SELECT * FROM webhooks WHERE url = 'https://hooks.example.test/b'").get() as Record<string, unknown>;
    expect(wB.enabled).toBe(0);
    expect(wB.created_at).toBeGreaterThan(0); // Date.now() fallback for omitted metadata
  });

  it('orders client_keys BEFORE budgets: an envelope-only scope_id resolves; a ghost one errors per-row without aborting', () => {
    const env = baseEnvelope();
    env.sections.budgets!.push({ scope: 'client_key', scopeId: 'ck_ghost', dailyLimitCents: 100 });
    const res = runImport({ envelope: env, options: { mode: 'skip-existing', dryRun: false } });
    expect(res.sections.budgets?.errors ?? []).toHaveLength(1);
    expect(res.sections.budgets?.errors?.[0]).toContain('ck_ghost');
    // The transaction continued: valid rows all landed, only the ghost was skipped.
    expect(count('client_keys')).toBe(2);
    expect(count('budgets')).toBe(2);
    expect(count('webhooks')).toBe(2);
  });

  it('forces global budgets to NULL scope_id even when scopeId is supplied', () => {
    const env = baseEnvelope();
    env.sections.budgets = [{ scope: 'global', scopeId: 'ck_aaa', monthlyLimitCents: 1 }];
    runImport({ envelope: env, options: { mode: 'overwrite', dryRun: false } });
    expect(count('budgets')).toBe(1);
    expect((getDb().prepare('SELECT scope_id FROM budgets').get() as { scope_id: string | null }).scope_id).toBeNull();
  });

  it('replace wipes destination-only rows in the three sections', () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO client_keys (id, secret_hash, salt, label, enabled, created_at_ms) VALUES ('ck_dest', 'h', 's', 'Dest', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO webhooks (url, secret, events_filter, enabled, created_at) VALUES ('https://dest.example.test', 'x', '*', 1, 1)",
    ).run();
    db.prepare("INSERT INTO budgets (scope, scope_id, monthly_limit_cents) VALUES ('global', NULL, 999)").run();

    runImport({ envelope: baseEnvelope(), options: { mode: 'replace', dryRun: false } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM client_keys WHERE id='ck_dest'").get()).toEqual({ n: 0 });
    expect(count('client_keys')).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE url LIKE 'https://dest%'").get()).toEqual({ n: 0 });
    expect(count('budgets')).toBe(2);
  });

  it('collapses repeated natural keys within one envelope (NULL-safe for budgets, url-keyed for webhooks)', () => {
    const env = baseEnvelope();
    // UNIQUE(scope, scope_id) does NOT catch ('global', NULL) repeats, and
    // webhooks.url has no UNIQUE constraint at all — both must still end up
    // single-row after a double import.
    env.sections.budgets = [
      { scope: 'global', monthlyLimitCents: 100 },
      { scope: 'global', monthlyLimitCents: 100 },
    ];
    env.sections.webhooks = [
      { url: 'https://dup.example.test', secret: 'first', eventsFilter: '*', enabled: true },
      { url: 'https://dup.example.test', secret: 'second', eventsFilter: '*', enabled: true },
    ];
    for (const mode of ['skip-existing', 'overwrite', 'replace'] as const) {
      wipe();
      runImport({ envelope: structuredClone(env), options: { mode, dryRun: false } });
      runImport({ envelope: structuredClone(env), options: { mode, dryRun: false } });
      expect(count('budgets')).toBe(1);
      expect(count('webhooks')).toBe(1);
    }
  });

  it('section filter accepts the new names and leaves unselected sections untouched', () => {
    const res = runImport({
      envelope: baseEnvelope(),
      options: { mode: 'skip-existing', dryRun: false, sections: ['webhooks'] },
    });
    expect(res.effectiveOptions.sections).toEqual(['webhooks']);
    expect(count('webhooks')).toBe(2);
    expect(count('client_keys')).toBe(0);
    expect(count('budgets')).toBe(0);
  });

  it('dryRun rolls the new sections back completely', () => {
    const res = runImport({ envelope: baseEnvelope(), options: { mode: 'replace', dryRun: true } });
    expect(res.dryRun).toBe(true);
    expect(count('client_keys')).toBe(0);
    expect(count('budgets')).toBe(0);
    expect(count('webhooks')).toBe(0);
  });

  it('keyCompatibility plaintext classification stays independent of destination ENCRYPTION_KEY handling', () => {
    const env = baseEnvelope();
    env.sections.apiKeys = [
      { platform: 'openai', label: 'plain', enabled: true, key: 'sk-plain-text' },
    ];
    expect(probeKeyCompatibility(env)).toBe('plaintext');
  });

  it('transcription_models and embedding_models round-trip every field through export/import shape', () => {
    // Envelope mirrors what buildExport emits for these sections: family
    // records with provider lists, family-level fields, and the section
    // defaultFamily. Providers groq/ovh/cloudflare/huggingface are public
    // built-ins.
    const base = baseEnvelope();
    const env: ConfigEnvelope = {
      ...base,
      sections: {
        ...base.sections,
        transcriptions: {
          defaultFamily: 'whisper-large-v3-turbo',
          families: [{
            family: 'whisper-large-v3-turbo',
            displayName: 'Whisper Large v3 Turbo',
            maxFileMb: 25,
            supportsTranslations: false,
            quotaLabel: '',
            providers: [
              { platform: 'groq', modelId: 'whisper-large-v3-turbo', priority: 1, enabled: true, pricePerHourUsd: 0.04 },
              { platform: 'ovh', modelId: 'whisper-large-v3-turbo', priority: 2, enabled: false, pricePerHourUsd: null },
            ],
          }],
        },
        embeddings: {
          defaultFamily: 'bge-m3',
          families: [{
            family: 'bge-m3',
            displayName: 'BGE-M3',
            dimensions: 1024,
            maxInputTokens: 8192,
            quotaLabel: '',
            providers: [
              { platform: 'cloudflare', modelId: '@cf/baai/bge-m3', priority: 1, enabled: true },
              { platform: 'huggingface', modelId: 'BAAI/bge-m3', priority: 2, enabled: false },
            ],
          }],
        },
      },
    };

    // previewEnvelope counts FAMILIES for these two sections.
    const p = previewEnvelope(structuredClone(env));
    expect(p.sections.transcriptions).toBe(1);
    expect(p.sections.embeddings).toBe(1);

    const expectedTm = [
      { family: 'whisper-large-v3-turbo', platform: 'groq', model_id: 'whisper-large-v3-turbo', display_name: 'Whisper Large v3 Turbo', max_file_mb: 25, supports_translations: 0, price_per_hour_usd: 0.04, priority: 1, enabled: 1, quota_label: '' },
      { family: 'whisper-large-v3-turbo', platform: 'ovh', model_id: 'whisper-large-v3-turbo', display_name: 'Whisper Large v3 Turbo', max_file_mb: 25, supports_translations: 0, price_per_hour_usd: null, priority: 2, enabled: 0, quota_label: '' },
    ];
    const expectedEm = [
      { family: 'bge-m3', platform: 'cloudflare', model_id: '@cf/baai/bge-m3', display_name: 'BGE-M3', dimensions: 1024, max_input_tokens: 8192, priority: 1, enabled: 1, quota_label: '' },
      { family: 'bge-m3', platform: 'huggingface', model_id: 'BAAI/bge-m3', display_name: 'BGE-M3', dimensions: 1024, max_input_tokens: 8192, priority: 2, enabled: 0, quota_label: '' },
    ];
    const tmRows = () => getDb().prepare(
      'SELECT family, platform, model_id, display_name, max_file_mb, supports_translations, price_per_hour_usd, priority, enabled, quota_label FROM transcription_models ORDER BY platform',
    ).all();
    const emRows = () => getDb().prepare(
      'SELECT family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label FROM embedding_models ORDER BY platform',
    ).all();
    const defaultFamilies = () => ({
      t: (getDb().prepare("SELECT value FROM settings WHERE key = 'transcriptions_default_family'").get() as { value: string } | undefined)?.value,
      e: (getDb().prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get() as { value: string } | undefined)?.value,
    });

    for (const mode of ['skip-existing', 'overwrite', 'replace'] as const) {
      // Start from empty catalogs AND no default-family settings: proves the
      // import writes every column and both settings keys, not just patches.
      const db = getDb();
      db.prepare('DELETE FROM transcription_models').run();
      db.prepare('DELETE FROM embedding_models').run();
      db.prepare("DELETE FROM settings WHERE key IN ('transcriptions_default_family','embeddings_default_family')").run();

      const first = runImport({ envelope: structuredClone(env), options: { mode, dryRun: false } });
      expect(first.sections.transcriptions?.errors ?? []).toEqual([]);
      expect(first.sections.embeddings?.errors ?? []).toEqual([]);
      expect(count('transcription_models')).toBe(2);
      expect(count('embedding_models')).toBe(2);
      expect(tmRows()).toEqual(expectedTm);
      expect(emRows()).toEqual(expectedEm);
      expect(defaultFamilies()).toEqual({ t: 'whisper-large-v3-turbo', e: 'bge-m3' });

      // Same envelope again: zero duplicates in every mode.
      const second = runImport({ envelope: structuredClone(env), options: { mode, dryRun: false } });
      expect(second.sections.transcriptions?.errors ?? []).toEqual([]);
      expect(second.sections.embeddings?.errors ?? []).toEqual([]);
      expect(count('transcription_models')).toBe(2);
      expect(count('embedding_models')).toBe(2);
      expect(tmRows()).toEqual(expectedTm);
      expect(emRows()).toEqual(expectedEm);
      expect(defaultFamilies()).toEqual({ t: 'whisper-large-v3-turbo', e: 'bge-m3' });
      if (mode === 'replace') {
        // Wipe-and-reinsert: every row counts as added again, nothing accumulates.
        expect(second.sections.transcriptions?.added).toBe(2);
        expect(second.sections.embeddings?.added).toBe(2);
      } else {
        expect(second.sections.transcriptions?.added).toBe(0);
        expect(second.sections.embeddings?.added).toBe(0);
      }
    }
  });
});
