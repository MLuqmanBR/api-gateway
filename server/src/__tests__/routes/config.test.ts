// End-to-end tests for the configuration export / import API. These
// spin up the full Express app against an in-memory database, walk
// every public endpoint, and assert on the JSON payloads plus the
// resulting database state.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { encrypt } from '../../lib/crypto.js';
import type { ConfigEnvelope, ConfigImportSummary } from '@api-gateway/shared';
let dashToken = '';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  server.close();
  return { status: res.status, body: data };
}

async function rawRequest(
  app: Express,
  method: string,
  path: string,
  init: RequestInit = {},
) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...init });
    return { status: res.status, headers: res.headers };
  } finally {
    server.close();
  }
}

function seedModels(): void {
  const db = getDb();
  db.prepare(`DELETE FROM fallback_config`).run();
  db.prepare(`DELETE FROM models`).run();
  db.prepare(`DELETE FROM custom_providers`).run();
  db.prepare(`DELETE FROM api_keys`).run();
  db.prepare(`DELETE FROM embedding_models`).run();
  db.prepare(`DELETE FROM settings WHERE key IN ('routing_strategy','global_retry_limit','routing_custom_weights','embeddings_default_family')`).run();
  db.prepare(`DELETE FROM quirks`).run();
  db.prepare(`DELETE FROM quirk_targets`).run();

  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools, max_output_tokens,
      paid_input_per_m, paid_output_per_m)
    VALUES ('groq', 'llama-3.3-70b', 'Llama 3.3 70B', 12, 8, 'Large', 30, 14400, NULL, NULL,
        '', 131072, 1, 0, 1, NULL, NULL, NULL)
  `).run();

  db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES
    ((SELECT id FROM models WHERE platform='groq' AND model_id='llama-3.3-70b'), 0, 1)
  `).run();

  const k = encrypt('sk-test-1234567890');
  db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'main', ?, ?, ?, 'unknown', 1)`).run(k.encrypted, k.iv, k.authTag);
}

describe('Config API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    seedModels();
  });

  // ── Inventory ─────────────────────────────────────────────────────────

  it('GET /api/config/inventory returns row counts', async () => {
    const { status, body } = await request(app, 'GET', '/api/config/inventory');
    expect(status).toBe(200);
    expect(body.models).toBeGreaterThanOrEqual(1);
    expect(body.fallback_chain).toBeGreaterThanOrEqual(1);
    expect(body.custom_providers).toBe(0);
    expect(body.api_keys).toBe(1);
  });

  // ── Export ────────────────────────────────────────────────────────────

  it('POST /api/config/export returns a valid envelope', async () => {
    const { status, body } = await request(app, 'POST', '/api/config/export', {});
    expect(status).toBe(200);
    expect(body.schemaVersion).toBeGreaterThan(0);
    expect(body.generator).toBe('api-gateway');
    expect(typeof body.exportedAt).toBe('string');
    expect(Array.isArray(body.sections.models)).toBe(true);
    expect(body.sections.fallbackChain).toHaveLength(1);
    expect(body.sections.apiKeys).toHaveLength(1);
    expect(body.sections.apiKeys[0].key).toBe('sk-test-1234567890');
  });

  it('POST /api/config/export with passphrase produces a keysCipher blob', async () => {
    const { status, body } = await request(app, 'POST', '/api/config/export', {
      passphrase: 'correct horse battery staple',
    });
    expect(status).toBe(200);
    expect(body.keysCipher).toBeDefined();
    expect(body.keysCipher.kdf).toBe('pbkdf2-sha256-310000');
    expect(body.sections.apiKeys[0].key).toBeUndefined();
    expect(body.sections.apiKeys[0].encryptedKey).toBeDefined();
    expect(body.sections.apiKeys[0].iv).toBeDefined();
    expect(body.sections.apiKeys[0].authTag).toBeDefined();
  });

  it('POST /api/config/export with download=true sets a well-formed Content-Disposition filename', async () => {
    // The server emits its timestamp in UTC because it doesn't know
    // the user's timezone — direct downloads (curl, scripts) get a
    // file with a UTC stamp. The browser dashboard rebuilds the
    // filename in the user's local time before download, so the
    // operator sees a familiar local timestamp. With a label, the
    // slug is folded in between the prefix and the timestamp.
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/config/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dashToken}`,
      },
      body: JSON.stringify({ download: true, label: 'staging-laptop' }),
    });
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    // `API_Gateway-Backup-<optional-slug>-YYYY-MM-DD-HH-mm-ss.json`
    expect(cd).toMatch(
      /filename="API_Gateway-Backup-(?:[a-z0-9-]+-)?\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json"/,
    );
    expect(cd).toContain('staging-laptop');
    server.close();
  });

  it('POST /api/config/export with download=true folds the label slug into the filename', async () => {
    // Operator-friendly behavior: a label like "Production" becomes
    // part of the filename so multiple exports in the same directory
    // are easy to tell apart. The slug rules are mirrored on the
    // client (client/src/lib/utils.ts) so dashboard downloads and
    // direct API downloads produce the same shape.
    async function fetchWith(label: string | undefined): Promise<string> {
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/config/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dashToken}`,
        },
        body: JSON.stringify({ download: true, ...(label ? { label } : {}) }),
      });
      expect(res.status).toBe(200);
      const cd = res.headers.get('content-disposition') ?? '';
      server.close();
      return cd;
    }
    // Slug rules:
    expect(await fetchWith('Production')).toContain('production-');
    expect(await fetchWith('Laptop staging')).toContain('laptop-staging-');
    expect(await fetchWith('  Trim Me  ')).toContain('trim-me-');
    expect(await fetchWith('Café résumé')).toContain('cafe-resume-');
    // Punctuation collapses to a single hyphen.
    expect(await fetchWith('a, b. c!')).toContain('a-b-c-');
    // Non-Latin (e.g. Devanagari) collapses to a hyphen — but the slug
    // is still defined; we just don't assert its exact characters.
    const cyrillic = await fetchWith('Привет мир');
    expect(cyrillic).toMatch(/API_Gateway-Backup-([a-z0-9-]+-)?\d{4}/);
    // Long label gets truncated to <= 32 chars and trimmed at a hyphen
    // boundary when one exists past index 16.
    const long = await fetchWith('this-is-a-very-long-label-that-should-be-truncated-okay');
    const longMatch = long.match(/filename="API_Gateway-Backup-([^-]+(?:-[^-]+)*?)-\d{4}/);
    expect(longMatch).not.toBeNull();
    expect(longMatch![1].length).toBeLessThanOrEqual(32);
    // Missing label: no slug in the filename.
    const none = await fetchWith(undefined);
    expect(none).toMatch(
      /filename="API_Gateway-Backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json"/,
    );
  });

  it('POST /api/config/export rejects unknown sections', async () => {
    const { status, body } = await request(app, 'POST', '/api/config/export', {
      sections: ['unknown_section'],
    });
    expect(status).toBe(400);
    expect(body.error.message).toBeDefined();
  });

  // ── Preview ───────────────────────────────────────────────────────────

  it('POST /api/config/preview returns counts and metadata', async () => {
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{
          platform: 'groq', modelId: 'llama-3.3-70b',
          displayName: 'X', intelligenceRank: 1, speedRank: 1,
          sizeLabel: '', rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: null,
          enabled: true, supportsVision: false, supportsTools: true,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
        }],
      },
    };
    const { status, body } = await request(app, 'POST', '/api/config/preview', env);
    expect(status).toBe(200);
    expect(body.sections.models).toBe(1);
    expect(body.schemaVersion).toBe(1);
    expect(body.hasKeysCipher).toBe(false);
  });

  it('POST /api/config/preview rejects an invalid envelope', async () => {
    const { status, body } = await request(app, 'POST', '/api/config/preview', {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{ platform: '', modelId: '', displayName: '' }],
      },
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/Invalid envelope/);
  });

  // ── Import: round-trip ────────────────────────────────────────────────

  it('POST /api/config/import round-trips: export then re-import produces no-op diff in skip-existing', async () => {
    const exp = await request(app, 'POST', '/api/config/export', {});
    const env = exp.body as ConfigEnvelope;

    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: false },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.dryRun).toBe(false);
    expect(imp.body.mode).toBe('skip-existing');
    expect(imp.body.sections.models?.skipped).toBeGreaterThanOrEqual(1);
    expect(imp.body.sections.api_keys?.skipped).toBe(1);
  });

  it('fallback chain: no-op round-trip preserves priorities and reports zero updates', async () => {
    // Regression: the fallback importer previously used a 0-based
    // index for the priority comparison/write, while every other
    // writer in the codebase uses 1-based. So a no-op round-trip
    // reported ~930 false "updated" entries, and a committed import
    // would have shifted every priority by -1. This test seeds
    // three rows with priority 1, 2, 3 — export then re-import —
    // and asserts the diff is fully skipped with priorities intact.
    const db = getDb();
    db.prepare(`DELETE FROM fallback_config`).run();
    db.prepare(`DELETE FROM models`).run();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, max_output_tokens,
        paid_input_per_m, paid_output_per_m)
      VALUES ('fallbacktest', 'alpha', 'Alpha', 10, 5, 'Medium', NULL, NULL, NULL, NULL,
              '', NULL, 1, 0, 0, NULL, NULL, NULL)
    `).run();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, max_output_tokens,
        paid_input_per_m, paid_output_per_m)
      VALUES ('fallbacktest', 'bravo', 'Bravo', 11, 6, 'Medium', NULL, NULL, NULL, NULL,
              '', NULL, 1, 0, 0, NULL, NULL, NULL)
    `).run();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, max_output_tokens,
        paid_input_per_m, paid_output_per_m)
      VALUES ('fallbacktest', 'charlie', 'Charlie', 12, 7, 'Large', NULL, NULL, NULL, NULL,
              '', NULL, 1, 0, 0, NULL, NULL, NULL)
    `).run();
    db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES
      ((SELECT id FROM models WHERE platform='fallbacktest' AND model_id='alpha'),   1, 1),
      ((SELECT id FROM models WHERE platform='fallbacktest' AND model_id='bravo'),   2, 1),
      ((SELECT id FROM models WHERE platform='fallbacktest' AND model_id='charlie'), 3, 0)
    `).run();
    // Register the custom provider so the importer doesn't treat
    // `fallbacktest` as an unknown platform.
    db.prepare(`INSERT OR IGNORE INTO custom_providers (slug, display_name, base_url)
      VALUES ('fallbacktest', 'Fallback Test', 'https://fb.test/v1')`).run();

    const exp = await request(app, 'POST', '/api/config/export', {});
    expect(exp.status).toBe(200);
    const env = exp.body as ConfigEnvelope;
    expect(env.sections.fallbackChain).toHaveLength(3);
    // Export must be in priority order: alpha (1), bravo (2), charlie (3),
    // and each entry must carry the stored `priority` so a no-op
    // round-trip can detect the match without inferring from index.
    expect(env.sections.fallbackChain?.[0]).toMatchObject({ modelId: 'alpha', priority: 1, enabled: true });
    expect(env.sections.fallbackChain?.[1]).toMatchObject({ modelId: 'bravo', priority: 2, enabled: true });
    expect(env.sections.fallbackChain?.[2]).toMatchObject({ modelId: 'charlie', priority: 3, enabled: false });

    const before = db.prepare(`SELECT fc.priority, fc.enabled FROM fallback_config fc
      JOIN models ON models.id = fc.model_db_id
      WHERE models.model_id IN ('alpha','bravo','charlie')
      ORDER BY fc.priority`).all() as Array<{ priority: number; enabled: number }>;
    expect(before.map((r) => r.priority)).toEqual([1, 2, 3]);

    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: false },
    });
    expect(imp.status).toBe(200);
    const fc = imp.body.sections.fallback_chain as { added: number; updated: number; skipped: number; errors: string[] };
    expect(fc.errors).toEqual([]);
    // Every entry must be skipped — none added, none updated.
    expect(fc.updated).toBe(0);
    expect(fc.added).toBe(0);
    expect(fc.skipped).toBe(3);

    // Priorities must be byte-for-byte unchanged.
    const after = db.prepare(`SELECT fc.priority, fc.enabled FROM fallback_config fc
      JOIN models ON models.id = fc.model_db_id
      WHERE models.model_id IN ('alpha','bravo','charlie')
      ORDER BY fc.priority`).all() as Array<{ priority: number; enabled: number }>;
    expect(after).toEqual(before);
  });

  it('mode=overwrite updates an existing row when overwriteBuiltin is set', async () => {
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{
          platform: 'groq', modelId: 'llama-3.3-70b',
          displayName: 'Llama 3.3 70B (renamed)',
          intelligenceRank: 12, speedRank: 8,
          sizeLabel: 'Large', rpmLimit: 30, rpdLimit: 14400, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: 131072,
          enabled: true, supportsVision: false, supportsTools: true,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
          overwriteBuiltin: true,
        }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'overwrite', dryRun: false },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.models?.updated).toBe(1);
    const row = getDb().prepare(
      `SELECT display_name FROM models WHERE platform='groq' AND model_id='llama-3.3-70b'`,
    ).get() as { display_name: string };
    expect(row.display_name).toBe('Llama 3.3 70B (renamed)');
  });

  it('mode=skip-existing does not update an existing row', async () => {
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{
          platform: 'groq', modelId: 'llama-3.3-70b',
          displayName: 'Llama 3.3 70B (renamed)',
          intelligenceRank: 12, speedRank: 8,
          sizeLabel: 'Large', rpmLimit: 30, rpdLimit: 14400, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: 131072,
          enabled: true, supportsVision: false, supportsTools: true,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
        }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: false },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.models?.skipped).toBe(1);
    const row = getDb().prepare(
      `SELECT display_name FROM models WHERE platform='groq' AND model_id='llama-3.3-70b'`,
    ).get() as { display_name: string };
    expect(row.display_name).toBe('Llama 3.3 70B');
  });

  it('mode=replace wipes fallback chain then rebuilds from envelope', async () => {
    // Custom provider so the model is not built-in-guarded.
    getDb().prepare(`INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('replacetest', 'Replace Test', 'https://x.test/v1')`).run();
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{
          platform: 'replacetest', modelId: 'test-model',
          displayName: 'Test Model', intelligenceRank: 12, speedRank: 8,
          sizeLabel: 'Large', rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: null,
          enabled: true, supportsVision: false, supportsTools: true,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
        }],
        fallbackChain: [{
          platform: 'replacetest', modelId: 'test-model', priority: 1, enabled: true,
        }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'replace', dryRun: false },
    });
    // The seed inserted 1 fallback entry. After replace with the
    // custom model, exactly 1 entry remains (the new one).
    const count = (getDb().prepare(`SELECT COUNT(*) AS n FROM fallback_config`).get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('mode=replace wipes the models table before inserting from the envelope', async () => {
    // Regression: replace mode previously left built-in rows in place
    // because the per-row diff treated them as 'skip-existing'. The
    // documented contract is: replace = the export is the authoritative
    // source for the section. Build a destination with two custom
    // models and a chain, then import an envelope that only carries
    // ONE of those models. The other model and its chain entry must
    // be gone after the import.
    getDb().prepare(`INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('replaceA', 'A', 'https://a.test/v1')`).run();
    getDb().prepare(`INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('replaceB', 'B', 'https://b.test/v1')`).run();
    const insModel = getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, max_output_tokens,
        paid_input_per_m, paid_output_per_m)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', NULL, 1, 0, 0, NULL, NULL, NULL)
    `);
    insModel.run('replaceA', 'a-model', 'A Model', 10, 5, 'Medium');
    insModel.run('replaceB', 'b-model', 'B Model', 11, 6, 'Medium');
    // Seed fallback entries for both.
    const idA = (getDb().prepare('SELECT id FROM models WHERE platform=? AND model_id=?').get('replaceA', 'a-model') as { id: number }).id;
    const idB = (getDb().prepare('SELECT id FROM models WHERE platform=? AND model_id=?').get('replaceB', 'b-model') as { id: number }).id;
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1), (?, 2, 1)').run(idA, idB);
    // Build an envelope that only carries replaceA/a-model.
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{
          platform: 'replaceA', modelId: 'a-model',
          displayName: 'A Model', intelligenceRank: 10, speedRank: 5,
          sizeLabel: 'Medium', rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: null,
          enabled: true, supportsVision: false, supportsTools: false,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
        }],
        fallbackChain: [{
          platform: 'replaceA', modelId: 'a-model', priority: 1, enabled: true,
        }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'replace', dryRun: false },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.models?.errors ?? []).toEqual([]);
    // Only replaceA/a-model exists in the models table now.
    const remaining = getDb().prepare(`
      SELECT platform, model_id FROM models WHERE platform IN ('replaceA','replaceB')
    `).all() as Array<{ platform: string; model_id: string }>;
    expect(remaining.map((r) => `${r.platform}/${r.model_id}`).sort()).toEqual(['replaceA/a-model']);
    // And the chain has exactly 1 entry (replaceA/a-model).
    const chainCount = (getDb().prepare('SELECT COUNT(*) AS n FROM fallback_config').get() as { n: number }).n;
    expect(chainCount).toBe(1);
  });

  it('mode=replace on api_keys re-inserts rows so status resets to unknown', async () => {
    // In replace mode, deleting the existing row and re-inserting
    // resets runtime state (status, created_at, last_checked_at).
    // seedModels() (beforeEach) already inserts a groq/main key.
    const db = getDb();
    // Mark the existing row as 'unhealthy' with a known last_checked_at.
    const before = db.prepare("SELECT id, status, last_checked_at FROM api_keys WHERE platform='groq'").get() as { id: number; status: string; last_checked_at: string | null };
    db.prepare("UPDATE api_keys SET status='unhealthy', last_checked_at='2026-01-01 00:00:00' WHERE id=?").run(before.id);
    // Build an envelope with the same key but only carrying enabled + baseUrl.
    const exp = await request(app, 'POST', '/api/config/export', { sections: ['api_keys'] });
    const env = exp.body as ConfigEnvelope;
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'replace', dryRun: false },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.api_keys?.errors ?? []).toEqual([]);
    expect(imp.body.sections.api_keys?.added).toBeGreaterThan(0);
    // After replace, the row's status should be 'unknown' (re-inserted fresh).
    const after = db.prepare("SELECT status, last_checked_at FROM api_keys WHERE platform='groq'").get() as { status: string; last_checked_at: string | null };
    expect(after.status).toBe('unknown');
  });

  it('passphrase-encrypted keys round-trip when passphrase is supplied', async () => {
    const exp = await request(app, 'POST', '/api/config/export', {
      passphrase: 'secret',
    });
    const env = exp.body as ConfigEnvelope;
    expect(env.keysCipher).toBeDefined();
    expect(env.sections.apiKeys?.[0]?.key).toBeUndefined();

    const db = getDb();
    db.prepare(`DELETE FROM api_keys`).run();

    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'overwrite', dryRun: false, passphrase: 'secret' },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.api_keys?.added).toBe(1);

    const stored = db.prepare(
      `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform='groq' LIMIT 1`,
    ).get() as { encrypted_key: string; iv: string; auth_tag: string };
    expect(stored.encrypted_key.length).toBeGreaterThan(0);
  });

  it('passphrase-encrypted keys fail with wrong passphrase', async () => {
    const exp = await request(app, 'POST', '/api/config/export', {
      passphrase: 'correct',
    });
    const env = exp.body as ConfigEnvelope;
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'overwrite', dryRun: false, passphrase: 'wrong' },
    });
    expect(imp.status).toBe(401);
    expect(imp.body.error.message).toMatch(/passphrase/i);
  });

  it('envelope with keysCipher but no passphrase supplied → 400', async () => {
    const exp = await request(app, 'POST', '/api/config/export', { passphrase: 'p' });
    const env = exp.body as ConfigEnvelope;
    const imp = await request(app, 'POST', '/api/config/import', { envelope: env });
    expect(imp.status).toBe(400);
    expect(imp.body.error.message).toMatch(/passphrase/i);
  });

  it('newer-schema envelope is rejected', async () => {
    const env = {
      schemaVersion: 999,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: { models: [{
        platform: 'groq', modelId: 'foo', displayName: 'Foo',
        intelligenceRank: 1, speedRank: 1, sizeLabel: '',
        rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
        monthlyTokenBudget: '', contextWindow: null,
        enabled: true, supportsVision: false, supportsTools: true,
        maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
      }] },
    };
    const imp = await request(app, 'POST', '/api/config/import', { envelope: env });
    expect(imp.status).toBe(400);
    expect(imp.body.error.message).toMatch(/schemaVersion/);
  });
  it('config routes are mounted under /api/config', async () => {
    // The auth gate is bypassed for loopback callers (see #35), so we
    // can't easily assert 401 from tests. Instead, verify the route
    // exists by hitting it (returns 200 on loopback).
    const { status } = await rawRequest(app, 'GET', '/api/config/inventory');
    expect(status).toBe(200);
  });

  it('custom_providers section persists across export → import', async () => {
    getDb().prepare(`INSERT INTO custom_providers (slug, display_name, base_url) VALUES ('mycorp', 'MyCorp', 'https://api.mycorp.local/v1')`).run();
    const exp = await request(app, 'POST', '/api/config/export', { sections: ['custom_providers'] });
    const env = exp.body as ConfigEnvelope;
    // Wipe destination, re-import in replace mode
    getDb().prepare(`DELETE FROM custom_providers`).run();
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'replace', dryRun: false },
    });
    expect(imp.status).toBe(200);
    const rows = getDb().prepare(`SELECT slug FROM custom_providers`).all() as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug)).toContain('mycorp');
  });

  it('dry-run result is the same shape as a committed result', async () => {
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        settings: { routingStrategy: 'balanced' },
      },
    };
    const dry = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'overwrite', dryRun: true },
    });
    expect(dry.status).toBe(200);
    const body = dry.body as ConfigImportSummary;
    expect(body.dryRun).toBe(true);
    expect(body).toHaveProperty('sections');
    expect(body).toHaveProperty('mode');
    expect(body).toHaveProperty('importedAt');
  });

  it('empty envelope (no sections) is rejected', async () => {
    const env = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {},
    };
    const imp = await request(app, 'POST', '/api/config/import', { envelope: env });
    expect(imp.status).toBe(400);
    expect(imp.body.error.message).toMatch(/at least one section/);
  });

  // ── No-op detection ───────────────────────────────────────────────
  // These guard against the regression where re-importing an unchanged
  // envelope reported every record as `updated` (the user re-imports
  // the same file and sees a sea of green instead of an empty diff).

  it('re-importing an unchanged settings section produces zero updates', async () => {
    // Make sure settings actually exist in the destination so a
    // re-import has something to compare against.
    const db = getDb();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('routing_strategy', 'priority')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('global_retry_limit', '0')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('embeddings_default_family', 'gemini-embedding-001')`).run();

    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        settings: {
          routingStrategy: 'priority',
          globalRetryLimit: 0,
        },
        embeddings: {
          defaultFamily: 'gemini-embedding-001',
          families: [],
        },
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: true },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.settings?.updated).toBe(0);
    expect(imp.body.sections.embeddings?.updated).toBe(0);
    // Every present key should be counted as skipped, not updated.
    expect(imp.body.sections.settings?.skipped).toBe(2);
    expect(imp.body.sections.embeddings?.skipped).toBe(1);
  });

  it('re-importing an unchanged custom_providers row produces zero updates', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO custom_providers (slug, display_name, base_url, rpm_limit, api_format)
      VALUES ('acme', 'Acme', 'https://acme.test/v1', 60, 'openai')`).run();
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        customProviders: [{
          slug: 'acme',
          displayName: 'Acme',
          baseUrl: 'https://acme.test/v1',
          rpmLimit: 60, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          maxParallelRequests: null, archived: false, keyless: false,
          apiFormat: 'openai',
        }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: true },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.custom_providers?.updated).toBe(0);
    expect(imp.body.sections.custom_providers?.skipped).toBe(1);
  });

  it('fallback chain entries for built-in models resolve and do NOT error', async () => {
    // Seed a built-in platform with a model + fallback entry. The
    // import envelope references the same model. The chain entry
    // must resolve to the existing id and report skipped (no change),
    // not error.
    const db = getDb();
    const r = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
         size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
       VALUES ('groq', 'mixtral-8x7b', 'Mixtral 8x7B', 10, 7, 'Large', '', 1, 0, 1)`,
    ).run();
    const modelId = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)`).run(modelId);

    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        models: [{
          platform: 'groq', modelId: 'mixtral-8x7b',
          displayName: 'Mixtral 8x7B', intelligenceRank: 10, speedRank: 7,
          sizeLabel: 'Large', rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: null,
          enabled: true, supportsVision: false, supportsTools: true,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
        }],
        fallbackChain: [{ platform: 'groq', modelId: 'mixtral-8x7b', priority: 1, enabled: true }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: true },
    });
    expect(imp.status).toBe(200);
    const fc = imp.body.sections.fallback_chain;
    // Model is built-in (groq is a built-in Platform), so it gets
    // skipped at the model level. The fallback entry must still
    // resolve to the existing id and be reported as skipped, not
    // errored.
    expect(fc?.errors ?? []).toEqual([]);
    expect(fc?.skipped).toBe(1);
    expect(fc?.updated).toBe(0);
  });

  it('fallback chain for a NEW model (insert + chain in one import) updates correctly', async () => {
    // No model in the destination, but the envelope introduces it
    // AND a fallback entry. The chain should be added (not error).
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        customProviders: [{
          slug: 'acme', displayName: 'Acme', baseUrl: 'https://acme.test/v1',
          rpmLimit: 60, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          maxParallelRequests: null, archived: false, keyless: false,
          apiFormat: 'openai',
        }],
        models: [{
          platform: 'acme', modelId: 'fresh',
          displayName: 'Fresh', intelligenceRank: 10, speedRank: 5,
          sizeLabel: 'Small', rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null,
          monthlyTokenBudget: '', contextWindow: null,
          enabled: true, supportsVision: false, supportsTools: true,
          maxOutputTokens: null, paidInputPerM: null, paidOutputPerM: null,
        }],
        fallbackChain: [{ platform: 'acme', modelId: 'fresh', priority: 1, enabled: true }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: false },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.models?.added).toBe(1);
    expect(imp.body.sections.fallback_chain?.added).toBe(1);
    expect(imp.body.sections.fallback_chain?.errors ?? []).toEqual([]);
  });

  it('re-importing a quirk with identical fields + targets produces zero updates', async () => {
    const db = getDb();
    const r = db.prepare(
      `INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms)
       VALUES ('cool-tip', 'Cool tip', 'Use the playground', 'info', 1000, 1000)`,
    ).run();
    const qid = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, 'groq', '*')`).run(qid);
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        quirks: [{
          slug: 'cool-tip',
          title: 'Cool tip',
          body: 'Use the playground',
          severity: 'info',
          targets: [{ platform: 'groq', modelGlob: '*' }],
        }],
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'overwrite', dryRun: true },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.quirks?.updated).toBe(0);
    expect(imp.body.sections.quirks?.skipped).toBe(1);
  });

  it('re-importing an unchanged embedding family row produces zero updates', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO embedding_models (family, platform, model_id, display_name,
         dimensions, max_input_tokens, priority, enabled, quota_label)
       VALUES ('gemini-embedding-001', 'google', 'gemini-embedding-001',
         'Gemini Embedding', 768, 2048, 0, 1, '')`,
    ).run();
    const env: ConfigEnvelope = {
      schemaVersion: 1,
      generator: 'api-gateway',
      exportedAt: new Date().toISOString(),
      sections: {
        embeddings: {
          families: [{
            family: 'gemini-embedding-001',
            providers: [{ platform: 'google', modelId: 'gemini-embedding-001', priority: 0, enabled: true }],
            dimensions: 768,
            maxInputTokens: 2048,
            displayName: 'Gemini Embedding',
            quotaLabel: '',
          }],
        },
      },
    };
    const imp = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'overwrite', dryRun: true },
    });
    expect(imp.status).toBe(200);
    expect(imp.body.sections.embeddings?.updated).toBe(0);
    expect(imp.body.sections.embeddings?.skipped).toBe(1);
  });

  // ── Regression: a real-world export round-trips cleanly ──────────
  // Loads the user's actual export file (when present on disk in the
  // expected location) and asserts that:
  //   1. The first import against a fresh DB adds all rows, with no errors.
  //   2. The second import with skip-existing reports zero updates and
  //      zero errors.
  //   3. The fallback chain resolves every entry (no "model not in
  //      import" errors) — the original bug.
  //   4. The stored fallback priorities are invariant: a no-op import
  //      must not shift any row's priority. (Regression: the import
  //      previously used 0-based `idx` while the rest of the codebase
  //      writes 1-based `i + 1`, so a round-trip reported 930 false
  //      "updated" entries and would also corrupt the ordering if
  //      committed.)
  const realFile = path.join(homedir(), 'API_Gateway-Backup-2026-06-20-22-23-12.json');
  it.skipIf(!existsSync(realFile))('real export file round-trips without false-positive updates or errors', async () => {
    const env = JSON.parse(readFileSync(realFile, 'utf8')) as ConfigEnvelope;

    // First import: every record should be added, none skipped, no
    // errors. This populates the in-memory DB.
    const first = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: false },
    });
    expect(first.status).toBe(200);
    const firstSections = first.body.sections as Record<string, { added: number; updated: number; skipped: number; errors: string[] }>;
    // Built-in models + the `models`/`fallback_chain` sections the user
    // exported are 933 each. We expect the first import to add those
    // that don't already exist (i.e. the custom ones) — the rest are
    // skipped because they're built-in and the user didn't set
    // `overwriteBuiltin`. The point is: NO errors, and the fallback
    // chain must resolve to existing ids.
    expect(firstSections.fallback_chain?.errors ?? []).toEqual([]);
    expect(firstSections.models?.errors ?? []).toEqual([]);
    expect(firstSections.api_keys?.errors ?? []).toEqual([]);
    expect(firstSections.embeddings?.errors ?? []).toEqual([]);
    expect(firstSections.settings?.errors ?? []).toEqual([]);
    expect(firstSections.quirks?.errors ?? []).toEqual([]);
    expect(firstSections.custom_providers?.errors ?? []).toEqual([]);

    // Snapshot the fallback priorities after the first import so we
    // can assert they're unchanged after a no-op second import.
    const db = getDb();
    const beforePriorities = (db.prepare(`
      SELECT m.platform, m.model_id, fc.priority, fc.enabled
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      ORDER BY fc.priority ASC, fc.id ASC
    `).all() as Array<{ platform: string; model_id: string; priority: number; enabled: number }>)
      .map((r) => `${r.platform}\u0000${r.model_id}\u0000${r.priority}\u0000${r.enabled}`)
      .join('|');

    // Second import with skip-existing: a no-op. Zero added, zero
    // updated, zero errors.
    const second = await request(app, 'POST', '/api/config/import', {
      envelope: env,
      options: { mode: 'skip-existing', dryRun: false },
    });
    expect(second.status).toBe(200);
    const s = second.body.sections as Record<string, { added: number; updated: number; skipped: number; errors: string[] }>;
    expect(s.settings?.updated).toBe(0);
    expect(s.settings?.errors ?? []).toEqual([]);
    expect(s.fallback_chain?.updated).toBe(0);
    expect(s.fallback_chain?.added).toBe(0);
    expect(s.fallback_chain?.errors ?? []).toEqual([]);
    expect(s.custom_providers?.updated).toBe(0);
    expect(s.custom_providers?.errors ?? []).toEqual([]);
    expect(s.embeddings?.errors ?? []).toEqual([]);

    // Priorities must not have shifted. This is the strict invariant:
    // a no-op import must leave the database byte-for-byte equivalent
    // in fallback_config.
    const afterPriorities = (db.prepare(`
      SELECT m.platform, m.model_id, fc.priority, fc.enabled
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      ORDER BY fc.priority ASC, fc.id ASC
    `).all() as Array<{ platform: string; model_id: string; priority: number; enabled: number }>)
      .map((r) => `${r.platform}\u0000${r.model_id}\u0000${r.priority}\u0000${r.enabled}`)
      .join('|');
    expect(afterPriorities).toBe(beforePriorities);
  });
});
