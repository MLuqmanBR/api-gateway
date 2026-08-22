// Backup/restore overhaul — route-level regression suite.
//
// Everything here goes through the PUBLIC endpoints (POST /api/config/export,
// POST /api/config/import, GET /api/config/inventory) exactly like
// config.test.ts; appliers are never invoked directly.
//
// Cross-machine simulation: the ENCRYPTION_KEY lives in a module-global
// cache that migrateDbSchema refreshes on every initDb(path), and an
// explicit path always opens a FRESH private in-memory database. So
// bootGateway(K_A) → act → bootGateway(K_B) → act is a faithful two-machine
// sequence inside one process: gateway A's rows were ciphertext under K_A,
// the envelope is pure JSON, and every post-import assertion runs while K_B
// is the active key.
//
// Covered: A) no-passphrase / passphrase / wrong-passphrase restore onto a
// gateway with a DIFFERENT ENCRYPTION_KEY (including the historical
// multi-label-per-platform collapse bug); B) client_keys / budgets /
// webhooks round-trips in all three merge modes, double-import
// idempotency, per-row budget validation, usage-counter exclusion;
// C) key-transport policy guards and inventory counts.
import { describe, it, expect } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { encrypt, decrypt, hashClientSecret, generateSalt, maskKey } from '../../lib/crypto.js';
import { decryptKeysWithPassphrase } from '../../lib/config/passphrase-crypto.js';

const K_A = 'a'.repeat(64);
const K_B = 'b'.repeat(64);
const PASSPHRASE = 'correct horse battery staple 2026';

// ── Harness ───────────────────────────────────────────────────────────────

interface Gateway {
  app: Express;
  token: string;
}

function bootGateway(encryptionKeyHex: string): Gateway {
  process.env.ENCRYPTION_KEY = encryptionKeyHex;
  // Explicit path ⇒ always a brand-new private database (never the guarded
  // singleton path), and migrations re-run initEncryptionKey against the env
  // we just set — the module-global cipher key follows this gateway.
  initDb(':memory:');
  const app = createApp();
  // Session rows live in the ACTIVE database, so mint per gateway.
  const token = mintDashboardToken();
  return { app, token };
}

async function request(
  gw: Gateway,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const server = gw.app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(isGatedApiPath(path) ? { Authorization: `Bearer ${gw.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

async function exportEnvelope(gw: Gateway, opts: Record<string, unknown> = {}): Promise<any> {
  const res = await request(gw, 'POST', '/api/config/export', opts);
  expect(res.status).toBe(200);
  return res.body;
}

async function importEnvelope(
  gw: Gateway,
  envelope: unknown,
  options: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return request(gw, 'POST', '/api/config/import', { envelope, options });
}

interface SectionDiffJson {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  errors: string[];
}

/** Every section diff in an import summary must be error-free. */
function expectZeroErrors(summary: Record<string, SectionDiffJson>): void {
  for (const [section, diff] of Object.entries(summary)) {
    expect(diff?.errors ?? [], `section ${section} must import without errors`).toEqual([]);
  }
}

function qAll<T = Record<string, unknown>>(sql: string): T[] {
  return getDb().prepare(sql).all() as T[];
}

function qOne<T = Record<string, unknown>>(sql: string): T {
  const row = getDb().prepare(sql).get() as T | undefined;
  expect(row, `expected a row for: ${sql}`).toBeDefined();
  return row as T;
}

function qCount(sql: string): number {
  return (getDb().prepare(sql).get() as { n: number }).n;
}

// ── Seed helpers ──────────────────────────────────────────────────────────

// Three provider keys across TWO platforms, two DIFFERENT labels on groq —
// the exact shape the historical platform-only key lookup collapsed into a
// single shared key (the class of bug this suite makes impossible).
const API_KEY_DEFS = [
  { platform: 'groq', label: 'main', key: 'sk-groq-main-AAA111' },
  { platform: 'groq', label: 'secondary', key: 'sk-groq-secondary-BBB222' },
  { platform: 'openai', label: 'work', key: 'sk-openai-work-CCC333' },
];

/** Seed api_keys under the ACTIVE gateway's cipher key (call right after booting A). */
function seedApiKeys(): void {
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  for (const d of API_KEY_DEFS) {
    const k = encrypt(d.key);
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, 'unknown', 1)
    `).run(d.platform, d.label, k.encrypted, k.iv, k.authTag);
  }
}

const CK_ALPHA_SECRET = 'alpha-client-secret-0123456789abcdef';
const CK_BETA_SECRET = 'beta-client-secret-fedcba9876543210';

/** Seed the three overhaul sections with deliberately varied shapes. */
function seedNewSections(): void {
  const db = getDb();
  db.prepare('DELETE FROM budgets').run();
  db.prepare('DELETE FROM client_keys').run();
  db.prepare('DELETE FROM webhooks').run();

  const saltA = generateSalt();
  const saltB = generateSalt();
  db.prepare(`
    INSERT INTO client_keys (id, secret_hash, salt, label, enabled, expires_at_ms,
      model_allowlist, rpm_override, created_at_ms)
    VALUES ('ck_alpha', ?, ?, 'CI pipeline', 1, NULL, ?, 42, 1700000001000)
  `).run(hashClientSecret(CK_ALPHA_SECRET, saltA), saltA, JSON.stringify(['model-a/x', 'model-b/y']));
  db.prepare(`
    INSERT INTO client_keys (id, secret_hash, salt, label, enabled, expires_at_ms,
      model_allowlist, rpm_override, created_at_ms)
    VALUES ('ck_beta', ?, ?, 'Backup job', 0, NULL, NULL, NULL, 1700000002000)
  `).run(hashClientSecret(CK_BETA_SECRET, saltB), saltB);

  db.prepare(`
    INSERT INTO budgets (scope, scope_id, daily_limit_cents, weekly_limit_cents,
      monthly_limit_cents, weekly_reset_day)
    VALUES ('global', NULL, NULL, NULL, 10000, 1)
  `).run();
  db.prepare(`
    INSERT INTO budgets (scope, scope_id, daily_limit_cents, weekly_limit_cents,
      monthly_limit_cents, weekly_reset_day)
    VALUES ('client_key', 'ck_alpha', 500, NULL, NULL, 3)
  `).run();
  db.prepare(`
    INSERT INTO budgets (scope, scope_id, daily_limit_cents, weekly_limit_cents,
      monthly_limit_cents, weekly_reset_day)
    VALUES ('client_key', 'ck_beta', NULL, NULL, 2500, 1)
  `).run();

  db.prepare(`
    INSERT INTO webhooks (url, secret, events_filter, enabled, created_at)
    VALUES ('https://hooks.example.test/alpha', 'whsec-alpha-AAAA', '*', 1, 1700000003000)
  `).run();
  db.prepare(`
    INSERT INTO webhooks (url, secret, events_filter, enabled, created_at)
    VALUES ('https://hooks.example.test/beta', 'whsec-beta-BBBB', 'routing.*,request.error', 0, 1700000004000)
  `).run();
}

/**
 * Pre-seed one OVERLAPPING row per new section on the DESTINATION gateway —
 * same natural keys as the envelope (client-key id, budget scope pair,
 * webhook url) but divergent content, so skip-existing must preserve them
 * verbatim and overwrite must replace them in place.
 */
function seedOverlappingRowsOnDestination(): void {
  const db = getDb();
  const saltX = generateSalt();
  db.prepare(`
    INSERT INTO client_keys (id, secret_hash, salt, label, enabled, created_at_ms)
    VALUES ('ck_alpha', ?, ?, 'preexisting-label', 1, 1690000000000)
  `).run(hashClientSecret('preexisting-alpha-secret', saltX), saltX);
  db.prepare(`
    INSERT INTO budgets (scope, scope_id, daily_limit_cents, weekly_limit_cents,
      monthly_limit_cents, weekly_reset_day)
    VALUES ('global', NULL, NULL, NULL, 999, 1)
  `).run();
  db.prepare(`
    INSERT INTO webhooks (url, secret, events_filter, enabled, created_at)
    VALUES ('https://hooks.example.test/alpha', 'preexisting-whsecret', '*', 1, 1690000000000)
  `).run();
}

/** Content snapshot of the three new tables (surrogate ids excluded — they
 *  legitimately change under replace's wipe-and-reinsert). */
function dumpNewSections(): Record<string, unknown[]> {
  return {
    client_keys: qAll(`
      SELECT id, label, enabled, model_allowlist, rpm_override
      FROM client_keys ORDER BY id
    `),
    budgets: qAll(`
      SELECT scope, IFNULL(scope_id, '') AS scope_key, daily_limit_cents,
             weekly_limit_cents, monthly_limit_cents, weekly_reset_day
      FROM budgets ORDER BY scope, scope_key
    `),
    webhooks: qAll(`
      SELECT url, secret, events_filter, enabled
      FROM webhooks ORDER BY url
    `),
  };
}

interface RestoredApiKeyRow {
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

/** Assert the destination's api_keys table holds every source key, each
 *  DECRYPTING under the ACTIVE gateway's key (K_B) to the original
 *  plaintext — and that the two groq labels did not collapse onto one key. */
function expectRestoredKeysMatchSource(): void {
  const restored = qAll<RestoredApiKeyRow>(`
    SELECT platform, label, encrypted_key, iv, auth_tag, status, enabled FROM api_keys
  `);
  expect(restored).toHaveLength(API_KEY_DEFS.length);
  const plaintexts = new Set<string>();
  for (const row of restored) {
    const src = API_KEY_DEFS.find((d) => d.platform === row.platform && d.label === row.label);
    expect(src, `restored row ${row.platform}/${row.label} must trace to a seeded key`).toBeDefined();
    const plain = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    expect(plain).toBe(src!.key);
    // The masked display form derives cleanly from the restored material.
    expect(maskKey(plain)).toBe(maskKey(src!.key));
    // Runtime health state resets on restore: fresh rows start 'unknown',
    // never carry the source machine's health verdict, and stay enabled.
    expect(row.status).toBe('unknown');
    expect(row.enabled).toBe(1);
    plaintexts.add(plain);
  }
  expect(plaintexts.size).toBe(API_KEY_DEFS.length);
}

// ── A. Cross-machine restore ──────────────────────────────────────────────

describe('backup overhaul — cross-machine restore (different ENCRYPTION_KEY)', () => {
  it('A1: no-passphrase backup restores every key on gateway B (skip-existing)', async () => {
    const gwA = bootGateway(K_A);
    seedApiKeys(); // ciphertext on disk under K_A
    const envelope = await exportEnvelope(gwA, {});

    const gwB = bootGateway(K_B);
    const res = await importEnvelope(gwB, envelope, { mode: 'skip-existing' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('skip-existing');
    expectZeroErrors(res.body.sections);
    expect(res.body.sections.api_keys.added).toBe(3);
    expect(res.body.keyCompatibility?.status).toBe('plaintext');

    // Active cipher key is now K_B: every restored row must decrypt under it.
    expectRestoredKeysMatchSource();
  }, 30000);

  it('A2: passphrase backup restores with ONLY the passphrase — nothing else crosses machines', async () => {
    const gwA = bootGateway(K_A);
    seedApiKeys();
    const envelope = await exportEnvelope(gwA, { passphrase: PASSPHRASE });
    expect(envelope.keysCipher).toBeDefined();

    const gwB = bootGateway(K_B);
    const res = await importEnvelope(gwB, envelope, { mode: 'skip-existing', passphrase: PASSPHRASE });
    expect(res.status).toBe(200);
    expectZeroErrors(res.body.sections);
    expect(res.body.sections.api_keys.added).toBe(3);
    expect(res.body.keyCompatibility?.status).toBe('encrypted-with-passphrase');

    expectRestoredKeysMatchSource();
  }, 30000);

  it('A3: wrong passphrase fails cleanly (400-class) and mutates nothing', async () => {
    const gwA = bootGateway(K_A);
    seedApiKeys();
    const envelope = await exportEnvelope(gwA, { passphrase: PASSPHRASE });

    const gwB = bootGateway(K_B);
    const res = await importEnvelope(gwB, envelope, { mode: 'skip-existing', passphrase: 'definitely-not-it' });
    // Clean client error — specifically 401 today — never a crash/5xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(typeof res.body?.error?.message).toBe('string');
    expect(res.body.error.message).toMatch(/passphrase|decrypt/i);
    // Decryption happens BEFORE the transaction opens: zero partial state.
    expect(qCount('SELECT COUNT(*) AS n FROM api_keys')).toBe(0);
  }, 30000);
});

// ── B. New sections round-trip × modes ────────────────────────────────────

describe('backup overhaul — client_keys / budgets / webhooks round-trip', () => {
  it('B1a replace into an EMPTY gateway: exact counts, resolvable scopes, byte-equal webhooks', async () => {
    const gwA = bootGateway(K_A);
    seedNewSections();
    const envelope = await exportEnvelope(gwA, {});

    const gwB = bootGateway(K_B);
    const res = await importEnvelope(gwB, envelope, { mode: 'replace' });
    expect(res.status).toBe(200);
    expectZeroErrors(res.body.sections);
    expect(res.body.sections.client_keys.added).toBe(2);
    expect(res.body.sections.budgets.added).toBe(3);
    expect(res.body.sections.webhooks.added).toBe(2);

    expect(qCount('SELECT COUNT(*) AS n FROM client_keys')).toBe(2);
    expect(qCount('SELECT COUNT(*) AS n FROM budgets')).toBe(3);
    expect(qCount('SELECT COUNT(*) AS n FROM webhooks')).toBe(2);

    // Every client_key budget resolves to a RESTORED client key id; the
    // global budget keeps its NULL scope.
    expect(qCount(`
      SELECT COUNT(*) AS n FROM budgets b
      WHERE b.scope = 'client_key'
        AND NOT EXISTS (SELECT 1 FROM client_keys ck WHERE ck.id = b.scope_id)
    `)).toBe(0);
    expect(qAll(`SELECT scope_id FROM budgets WHERE scope = 'client_key' ORDER BY scope_id`)
      .map((r) => r.scope_id)).toEqual(['ck_alpha', 'ck_beta']);
    expect(qCount(`SELECT COUNT(*) AS n FROM budgets WHERE scope = 'global' AND scope_id IS NULL`)).toBe(1);

    // Webhook secrets/eventsFilter byte-equal, '*' and filter-list alike.
    expect(qAll<{ url: string; secret: string; events_filter: string; enabled: number }>(`
      SELECT url, secret, events_filter, enabled FROM webhooks ORDER BY url
    `)).toEqual([
      { url: 'https://hooks.example.test/alpha', secret: 'whsec-alpha-AAAA', events_filter: '*', enabled: 1 },
      { url: 'https://hooks.example.test/beta', secret: 'whsec-beta-BBBB', events_filter: 'routing.*,request.error', enabled: 0 },
    ]);

    // modelAllowlist round-trips as parsed JSON; unrestricted stays NULL.
    const alpha = qOne<{ model_allowlist: string | null; rpm_override: number | null }>(
      `SELECT model_allowlist, rpm_override FROM client_keys WHERE id = 'ck_alpha'`,
    );
    expect(JSON.parse(alpha.model_allowlist!)).toEqual(['model-a/x', 'model-b/y']);
    expect(alpha.rpm_override).toBe(42);
    const beta = qOne<{ model_allowlist: string | null; rpm_override: number | null }>(
      `SELECT model_allowlist, rpm_override FROM client_keys WHERE id = 'ck_beta'`,
    );
    expect(beta.model_allowlist).toBeNull();
    expect(beta.rpm_override).toBeNull();
  }, 30000);

  it('B1b skip-existing over PARTIAL overlap: overlap skipped untouched, rest added, zero duplicates', async () => {
    const gwA = bootGateway(K_A);
    seedNewSections();
    const envelope = await exportEnvelope(gwA, {});

    const gwB = bootGateway(K_B);
    seedOverlappingRowsOnDestination();

    const res = await importEnvelope(gwB, envelope, { mode: 'skip-existing' });
    expect(res.status).toBe(200);
    expectZeroErrors(res.body.sections);
    expect(res.body.sections.client_keys.skipped).toBe(1);
    expect(res.body.sections.client_keys.added).toBe(1);
    expect(res.body.sections.budgets.skipped).toBe(1);
    expect(res.body.sections.budgets.added).toBe(2);
    expect(res.body.sections.webhooks.skipped).toBe(1);
    expect(res.body.sections.webhooks.added).toBe(1);

    // Exact final counts — the overlap must not duplicate.
    expect(qCount('SELECT COUNT(*) AS n FROM client_keys')).toBe(2);
    expect(qCount('SELECT COUNT(*) AS n FROM budgets')).toBe(3);
    expect(qCount('SELECT COUNT(*) AS n FROM webhooks')).toBe(2);

    // Overlapping rows kept their pre-existing content verbatim.
    expect(qOne<{ label: string }>(`SELECT label FROM client_keys WHERE id = 'ck_alpha'`).label)
      .toBe('preexisting-label');
    expect(qOne<{ monthly_limit_cents: number }>(
      `SELECT monthly_limit_cents FROM budgets WHERE scope = 'global'`,
    ).monthly_limit_cents).toBe(999);
    expect(qOne<{ secret: string }>(
      `SELECT secret FROM webhooks WHERE url = 'https://hooks.example.test/alpha'`,
    ).secret).toBe('preexisting-whsecret');

    // Non-overlapping envelope rows landed.
    expect(qCount(`SELECT COUNT(*) AS n FROM client_keys WHERE id = 'ck_beta'`)).toBe(1);
    expect(qCount(`SELECT COUNT(*) AS n FROM budgets WHERE scope = 'client_key' AND scope_id = 'ck_alpha'`)).toBe(1);
    expect(qCount(`SELECT COUNT(*) AS n FROM budgets WHERE scope = 'client_key' AND scope_id = 'ck_beta'`)).toBe(1);
    expect(qCount(`SELECT COUNT(*) AS n FROM webhooks WHERE url = 'https://hooks.example.test/beta'`)).toBe(1);
  }, 30000);

  it('B1c overwrite over DIVERGENT overlap: updated in place, counts identical', async () => {
    const gwA = bootGateway(K_A);
    seedNewSections();
    const envelope = await exportEnvelope(gwA, {});

    const gwB = bootGateway(K_B);
    seedOverlappingRowsOnDestination();

    const res = await importEnvelope(gwB, envelope, { mode: 'overwrite' });
    expect(res.status).toBe(200);
    expectZeroErrors(res.body.sections);
    expect(res.body.sections.client_keys.updated).toBe(1);
    expect(res.body.sections.budgets.updated).toBe(1);
    expect(res.body.sections.webhooks.updated).toBe(1);

    // Counts stay exactly as after the pre-seed + non-overlap adds.
    expect(qCount('SELECT COUNT(*) AS n FROM client_keys')).toBe(2);
    expect(qCount('SELECT COUNT(*) AS n FROM budgets')).toBe(3);
    expect(qCount('SELECT COUNT(*) AS n FROM webhooks')).toBe(2);

    // Divergent rows now carry the envelope's values.
    const alpha = qOne<{ label: string; model_allowlist: string | null; rpm_override: number | null }>(
      `SELECT label, model_allowlist, rpm_override FROM client_keys WHERE id = 'ck_alpha'`,
    );
    expect(alpha.label).toBe('CI pipeline');
    expect(JSON.parse(alpha.model_allowlist!)).toEqual(['model-a/x', 'model-b/y']);
    expect(alpha.rpm_override).toBe(42);
    expect(qOne<{ monthly_limit_cents: number }>(
      `SELECT monthly_limit_cents FROM budgets WHERE scope = 'global'`,
    ).monthly_limit_cents).toBe(10000);
    expect(qOne<{ secret: string }>(
      `SELECT secret FROM webhooks WHERE url = 'https://hooks.example.test/alpha'`,
    ).secret).toBe('whsec-alpha-AAAA');
  }, 30000);
});

describe('backup overhaul — double-import idempotency (anti-duplication core)', () => {
  for (const mode of ['skip-existing', 'overwrite', 'replace'] as const) {
    it(`B2 mode=${mode}: importing the SAME envelope twice yields identical table contents`, async () => {
      const gwA = bootGateway(K_A);
      seedNewSections();
      const envelope = await exportEnvelope(gwA, {});

      const gwB = bootGateway(K_B);
      const first = await importEnvelope(gwB, structuredClone(envelope), { mode });
      expect(first.status).toBe(200);
      expectZeroErrors(first.body.sections);
      const afterFirst = dumpNewSections();

      const second = await importEnvelope(gwB, structuredClone(envelope), { mode });
      expect(second.status).toBe(200);
      expectZeroErrors(second.body.sections);

      const afterSecond = dumpNewSections();
      // Explicit COUNT(*) equality per table…
      expect(afterSecond.client_keys.length).toBe(afterFirst.client_keys.length);
      expect(afterSecond.budgets.length).toBe(afterFirst.budgets.length);
      expect(afterSecond.webhooks.length).toBe(afterFirst.webhooks.length);
      // …and full CONTENT equality, not just counts.
      expect(afterSecond).toEqual(afterFirst);

      if (mode === 'replace') {
        // Replace wipes client_keys wholesale — a budget surviving against a
        // vanished key would be an orphan. There must be none.
        expect(qCount(`
          SELECT COUNT(*) AS n FROM budgets b
          WHERE b.scope = 'client_key'
            AND NOT EXISTS (SELECT 1 FROM client_keys ck WHERE ck.id = b.scope_id)
        `)).toBe(0);
      }
    }, 30000);
  }

  it('B3: ghost-scope budget becomes a per-row structured error; valid rows still apply', async () => {
    const gwA = bootGateway(K_A);
    seedNewSections();
    const envelope = await exportEnvelope(gwA, {});
    (envelope.sections.budgets as Array<Record<string, unknown>>).push({
      scope: 'client_key',
      scopeId: 'ck_ghost',
      dailyLimitCents: 123,
    });

    const gwB = bootGateway(K_B);
    const res = await importEnvelope(gwB, envelope, { mode: 'skip-existing' });
    // Completed with per-row errors — matching the existing convention of
    // collecting them in the section diff instead of failing the request.
    expect(res.status).toBe(200);
    const budgets = res.body.sections.budgets;
    expect(Array.isArray(budgets.errors)).toBe(true);
    expect(budgets.errors.length).toBeGreaterThanOrEqual(1);
    expect(budgets.errors.join('\n')).toContain('ck_ghost');
    expect(budgets.errors.join('\n')).toContain('scope_id');

    // The valid siblings were applied; the ghost row was not inserted.
    expect(budgets.added).toBe(3);
    expect(res.body.sections.client_keys.added).toBe(2);
    expect(qCount('SELECT COUNT(*) AS n FROM budgets')).toBe(3);
    expect(qCount(`SELECT COUNT(*) AS n FROM budgets WHERE scope_id = 'ck_ghost'`)).toBe(0);
  }, 30000);

  it('B4: usage counters are runtime state — limits copy, used cents reset to zero, reset_at NULL', async () => {
    const gwA = bootGateway(K_A);
    seedNewSections();
    getDb().prepare(`
      UPDATE budgets SET
        daily_used_cents = 525, weekly_used_cents = 900, monthly_used_cents = 4100,
        daily_reset_at = '2026-08-21T00:00:00.000Z',
        weekly_reset_at = '2026-08-18T00:00:00.000Z',
        monthly_reset_at = '2026-08-01T00:00:00.000Z'
      WHERE scope = 'client_key' AND scope_id = 'ck_alpha'
    `).run();

    const envelope = await exportEnvelope(gwA, {});
    // The envelope itself must not even contain used/reset fields.
    for (const b of envelope.sections.budgets as Array<Record<string, unknown>>) {
      for (const field of Object.keys(b)) {
        expect(field).toMatch(/^(scope|scopeId|dailyLimitCents|weeklyLimitCents|monthlyLimitCents|weeklyResetDay)$/);
      }
    }

    const gwB = bootGateway(K_B);
    const res = await importEnvelope(gwB, envelope, { mode: 'replace' });
    expect(res.status).toBe(200);
    expectZeroErrors(res.body.sections);

    const row = qOne<{
      daily_limit_cents: number; weekly_reset_day: number;
      daily_used_cents: number; weekly_used_cents: number; monthly_used_cents: number;
      daily_reset_at: string | null; weekly_reset_at: string | null; monthly_reset_at: string | null;
    }>(`
      SELECT daily_limit_cents, weekly_reset_day,
             daily_used_cents, weekly_used_cents, monthly_used_cents,
             daily_reset_at, weekly_reset_at, monthly_reset_at
      FROM budgets WHERE scope = 'client_key' AND scope_id = 'ck_alpha'
    `);
    // Limits copied…
    expect(row.daily_limit_cents).toBe(500);
    expect(row.weekly_reset_day).toBe(3);
    // …usage counters land at their DEFAULT 0 with NULL reset windows, so
    // the restored budget behaves like a brand-new one.
    expect(row.daily_used_cents).toBe(0);
    expect(row.weekly_used_cents).toBe(0);
    expect(row.monthly_used_cents).toBe(0);
    expect(row.daily_reset_at).toBeNull();
    expect(row.weekly_reset_at).toBeNull();
    expect(row.monthly_reset_at).toBeNull();
  }, 30000);
});

// ── C. Policy regression guards ───────────────────────────────────────────

describe('backup overhaul — key-transport policy guards', () => {
  it('C1: no-passphrase export embeds a non-empty plaintext key for EVERY decryptable row', async () => {
    const gwA = bootGateway(K_A);
    seedApiKeys();
    const envelope = await exportEnvelope(gwA, {});

    const rows = envelope.sections.apiKeys as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const byPair = new Map<string, unknown>();
    for (const row of rows) {
      expect(typeof row.key).toBe('string');
      expect((row.key as string).length).toBeGreaterThan(0);
      byPair.set(`${row.platform}\u0000${row.label}`, row.key);
    }
    // Machine-independent backups: the plaintext travels for all three
    // accounts, including both groq labels.
    for (const d of API_KEY_DEFS) {
      expect(byPair.get(`${d.platform}\u0000${d.label}`)).toBe(d.key);
    }
    // NOTE: rows may additionally retain their encryptedKey/iv/authTag
    // transport fields — harmless redundancy; the importer prefers `key`.
  }, 30000);

  it('C2: passphrase export moves keys into keysCipher, strips row plaintext, preserves labels', async () => {
    const gwA = bootGateway(K_A);
    seedApiKeys();
    const envelope = await exportEnvelope(gwA, { passphrase: PASSPHRASE });

    expect(envelope.keysCipher).toBeDefined();
    expect(envelope.keysCipher.kdf).toBe('pbkdf2-sha256-600000');
    const rows = envelope.sections.apiKeys as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.key).toBeUndefined();
    }

    // Labels survive INSIDE the cipher payload: each (platform, label) pair
    // unwraps to exactly its own plaintext — the anti-collapse guarantee.
    const unwrapped = decryptKeysWithPassphrase(envelope.keysCipher, PASSPHRASE);
    const byPair = new Map(unwrapped.map((u) => [`${u.platform}\u0000${u.label}`, u.key]));
    expect(byPair.size).toBe(3);
    for (const d of API_KEY_DEFS) {
      expect(byPair.get(`${d.platform}\u0000${d.label}`)).toBe(d.key);
    }

    // Guard the guarantee: a wrong passphrase cannot unwrap the blob.
    expect(() => decryptKeysWithPassphrase(envelope.keysCipher, 'wrong-passphrase')).toThrow();
  }, 30000);

  it('C3: inventory endpoint reports real nonzero counts for the new sections', async () => {
    const gwA = bootGateway(K_A);
    seedApiKeys();
    seedNewSections();

    const res = await request(gwA, 'GET', '/api/config/inventory');
    expect(res.status).toBe(200);
    expect(res.body.api_keys).toBe(3);
    expect(res.body.client_keys).toBe(2);
    expect(res.body.budgets).toBe(3);
    expect(res.body.webhooks).toBe(2);
  }, 30000);

  it('C5: preview and dry-run surface the new sections before any commit', async () => {
    // The restore-confirmation UI renders whatever /api/config/preview and a
    // dry-run import report. If either omitted client_keys/budgets/webhooks,
    // a user previewing a backup would see those sections vanish — reading
    // exactly like data loss — even though apply() restores them fine.
    const gwA = bootGateway(K_A);
    seedApiKeys();
    seedNewSections();
    const exp = await request(gwA, 'POST', '/api/config/export', {});
    expect(exp.status).toBe(200);
    const envelope = exp.body as ConfigEnvelope;

    const gwB = bootGateway(K_B);
    const prev = await request(gwB, 'POST', '/api/config/preview', envelope);
    expect(prev.status).toBe(200);
    expect(prev.body.sections.client_keys).toBe(2);
    expect(prev.body.sections.budgets).toBe(3);
    expect(prev.body.sections.webhooks).toBe(2);

    const dry = await importEnvelope(gwB, envelope, { mode: 'replace', dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.sections.client_keys.added).toBe(2);
    expect(dry.body.sections.budgets.added).toBe(3);
    expect(dry.body.sections.webhooks.added).toBe(2);

    // Rollback proof: a dry run must leave the destination untouched.
    const db = getDb();
    const count = (t: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count('client_keys')).toBe(0);
    expect(count('budgets')).toBe(0);
    expect(count('webhooks')).toBe(0);
  }, 30000);
});
