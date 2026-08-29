// Config import service. Validates an envelope, computes a diff against the
// destination catalog, and (on commit) atomically applies the changes in a
// single SQLite transaction.
//
// Modes:
//   - 'skip-existing': never touch existing rows. (default)
//   - 'overwrite': update existing rows in place, add missing.
//   - 'replace': wipe the destination section, then insert from the envelope.
//
// All sections are independently optional. Sections not present in the
// envelope leave the destination untouched. Within a single section,
// per-record errors are collected and surfaced in the summary — they do
// not abort the import; only structural failures (bad FK, schema
// violation, transaction error) do.
//
// `dryRun` runs the same logic but rolls back at the end via a savepoint
// returning the diff without committing.
import type { DatabasePort } from '../../db/types.js';
import { getDb, setSetting, getSetting } from '../../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import type { Platform } from '@api-gateway/shared';
import { hasProvider } from '../../providers/index.js';
import {
  CONFIG_SCHEMA_VERSION,
  CONFIG_GENERATOR,
  type ConfigEnvelope,
  type ConfigSection,
  type ConfigImportOptions,
  type ConfigImportSummary,
  type ConfigKeyCompatibility,
  type ConfigModel,
  type ConfigCustomProvider,
  type ConfigApiKey,
  type ConfigEmbeddingFamily,
  type ConfigSettings,
  type ConfigQuirk,
  type ConfigClientKey,
  type ConfigBudget,
  type ConfigWebhook,
} from '@api-gateway/shared';
import { normalizeOpenAiBaseUrl } from '../base-url.js';
import { configEnvelopeSchema, configImportOptionsSchema } from './schema.js';
import { decryptKeysWithPassphrase } from './passphrase-crypto.js';

/**
 * Cheap, side-effect-free compatibility check between an envelope's
 * api_keys section and the destination gateway's `ENCRYPTION_KEY`. Used
 * by the Settings UI's preview flow so the operator gets a clear banner
 * BEFORE they click Apply. Never writes to the DB.
 *
 * Precedence:
 *   1. No api_keys section at all         → 'no-keys'
 *   2. keysCipher blob present            → 'encrypted-with-passphrase'
 *      (per-row ciphertext is irrelevant; the operator must supply
 *      the passphrase at import time)
 *   3. Any row carries plaintext `key`    → 'plaintext' (no key
 *      dependency on the destination's ENCRYPTION_KEY)
 *   4. Probe one row's `encryptedKey/iv/authTag` with `decrypt()`
 *      under the destination's key.
 *        - success → 'compatible'
 *        - GCM auth-tag failure → 'mismatch'
 *
 * Only the FIRST row is probed — that's enough to decide the whole
 * section's compatibility without paying for PBKDF2 / AES across
 * potentially hundreds of rows.
 */
export function probeKeyCompatibility(env: ConfigEnvelope): ConfigKeyCompatibility {
  const list = env.sections.apiKeys;
  if (!list || list.length === 0) return 'no-keys';
  if (env.keysCipher) return 'encrypted-with-passphrase';
  if (list.some((k) => typeof k.key === 'string' && k.key.length > 0)) {
    return 'plaintext';
  }
  // Find the first row that carries pre-encrypted material. Rows
  // lacking any of the three fields are skipped — the apply path
  // surfaces their own errors during import.
  const probeTarget = list.find(
    (k) => typeof k.encryptedKey === 'string' && typeof k.iv === 'string' && typeof k.authTag === 'string',
  );
  if (!probeTarget || !probeTarget.encryptedKey || !probeTarget.iv || !probeTarget.authTag) {
    // Rows exist but none carry usable ciphertext — the apply path
    // will collect the per-row "no key material" errors. Surface
    // 'mismatch' anyway since the UI banner makes the operator look.
    return 'mismatch';
  }
  try {
    decrypt(probeTarget.encryptedKey, probeTarget.iv, probeTarget.authTag);
    return 'compatible';
  } catch {
    return 'mismatch';
  }
}

export class ConfigImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'ConfigImportError';
  }
}

interface SectionDiff {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  errors: string[];
}

function emptyDiff(): SectionDiff {
  return { added: 0, updated: 0, skipped: 0, removed: 0, errors: [] };
}

// Custom slugs flow through the same platform column but aren't part of
// the closed Platform union. Cast via `unknown` so the compiler keeps us
// honest about the widening — `hasProvider` only does a lookup.
function asPlatform(slug: string): Platform {
  return slug as unknown as Platform;
}

function uniqueSlug(db: DatabasePort, base: string): string {
  let candidate = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${n++}`;
    if (n > 1000) {
      throw new ConfigImportError(`could not allocate unique slug for "${base}"`);
    }
  }
  return candidate;
}

// ── Settings ──────────────────────────────────────────────────────────────

function applySettings(db: DatabasePort, settings: ConfigSettings, diff: SectionDiff): void {
  // For each present key, only increment `updated` when the value would
  // actually change. An idempotent re-import of an unchanged config must
  // report zero changes for the settings section.
  if (settings.routingStrategy) {
    const current = getSetting('routing_strategy');
    if (current !== settings.routingStrategy) {
      setSetting('routing_strategy', settings.routingStrategy);
      diff.updated++;
    } else {
      diff.skipped++;
    }
  }
  if (settings.globalRetryLimit !== undefined) {
    const current = getSetting('global_retry_limit');
    const next = String(settings.globalRetryLimit);
    if (current !== next) {
      setSetting('global_retry_limit', next);
      diff.updated++;
    } else {
      diff.skipped++;
    }
  }
  if (settings.customWeights) {
    const w = settings.customWeights;
    const sum = w.reliability + w.speed + w.intelligence;
    if (sum <= 0) {
      diff.errors.push('custom weights must not all be zero');
      return;
    }
    const normalized = {
      reliability: w.reliability / sum,
      speed: w.speed / sum,
      intelligence: w.intelligence / sum,
    };
    const current = getSetting('routing_custom_weights');
    const next = JSON.stringify(normalized);
    if (current !== next) {
      setSetting('routing_custom_weights', next);
      diff.updated++;
    } else {
      diff.skipped++;
    }
  }
  if (settings.embeddingsDefaultFamily !== undefined) {
    // L30: settings-section counterpart of the embeddings section's
    // defaultFamily. When both are present the embeddings section (applied
    // later) wins — same setting, last write is the section that also
    // carries the family rows.
    const current = getSetting('embeddings_default_family');
    if (current !== settings.embeddingsDefaultFamily) {
      setSetting('embeddings_default_family', settings.embeddingsDefaultFamily);
      diff.updated++;
    } else {
      diff.skipped++;
    }
  }
}

// ── Custom providers ──────────────────────────────────────────────────────

function applyCustomProviders(
  db: DatabasePort,
  list: ConfigCustomProvider[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
  ids: ConfigImportSummary['ids'],
): void {
  const diff = summary.custom_providers ?? emptyDiff();
  if (mode === 'replace') {
    // Wipe all custom providers before inserting. The export is the
    // authoritative source for this section. We also unlink any
    // api_keys, fallback_config entries, and models that reference
    // these slugs so the operator doesn't end up with FK-orphaned
    // rows in the destination. Order matters: fallback_config first
    // (REFERENCES models), then models, then api_keys, then
    // custom_providers.
    // M32: true section wipe — unlink dependents of ALL wiped providers
    // (destination slugs ∪ envelope slugs). Previously only envelope slugs
    // were unlinked, so destination-only providers were deleted here while
    // their models/api_keys/fallback_config rows survived as orphans.
    const destSlugs = (db.prepare('SELECT slug FROM custom_providers').all() as Array<{ slug: string }>).map((r) => r.slug);
    const slugs = Array.from(new Set([...destSlugs, ...list.map((cp) => cp.slug)]));
    if (slugs.length > 0) {
      // Build a parameterized IN clause; never interpolate user input.
      const placeholders = slugs.map(() => '?').join(',');
      db.prepare(`
        DELETE FROM fallback_config
         WHERE model_db_id IN (SELECT id FROM models WHERE platform IN (${placeholders}))
      `).run(...slugs);
      db.prepare(`DELETE FROM models WHERE platform IN (${placeholders})`).run(...slugs);
      db.prepare(`DELETE FROM api_keys WHERE platform IN (${placeholders})`).run(...slugs);
    }
    db.prepare('DELETE FROM custom_providers').run();
  }
  const normUrl = (cp: { apiFormat: string; baseUrl: string }): string =>
    cp.apiFormat === 'anthropic' ? cp.baseUrl.trim().replace(/\/+$/, '')
                                 : normalizeOpenAiBaseUrl(cp.baseUrl);
  for (const cp of list) {
    try {
      const existing = db.prepare(
        `SELECT id, display_name, base_url, rpm_limit, rpd_limit, tpm_limit,
                tpd_limit, max_parallel_requests, archived, keyless, api_format
         FROM custom_providers WHERE slug = ?`,
      ).get(cp.slug) as {
        id: number; display_name: string; base_url: string;
        rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null;
        tpd_limit: number | null; max_parallel_requests: number | null;
        archived: number | null; keyless: number | null; api_format: string | null;
      } | undefined;
      if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        const nextArchived = cp.archived ? 1 : 0;
        const nextKeyless = cp.keyless ? 1 : 0;
        const sameAsRow = (a: number | string | null, b: number | string | null): boolean =>
          // Nullish values match each other (SQLite NULL columns); L47:
          // everything else compares directly — the old three-branch form
          // collapsed to this.
          (a ?? null) === (b ?? null);
        const identical =
          existing.display_name === cp.displayName &&
        existing.base_url === normUrl(cp) &&
          sameAsRow(existing.rpm_limit, cp.rpmLimit) &&
          sameAsRow(existing.rpd_limit, cp.rpdLimit) &&
          sameAsRow(existing.tpm_limit, cp.tpmLimit) &&
          sameAsRow(existing.tpd_limit, cp.tpdLimit) &&
          sameAsRow(existing.max_parallel_requests, cp.maxParallelRequests) &&
          (existing.archived ?? 0) === nextArchived &&
          (existing.keyless ?? 0) === nextKeyless &&
          existing.api_format === cp.apiFormat;
        if (identical) {
          ids?.customProviders.push({ slug: cp.slug, id: existing.id });
          diff.skipped++;
          continue;
        }
        db.prepare(`
          UPDATE custom_providers SET
            display_name = ?, base_url = ?,
            rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?,
            max_parallel_requests = ?, archived = ?, keyless = ?, api_format = ?
          WHERE id = ?
        `).run(
          cp.displayName, normUrl(cp),
          cp.rpmLimit, cp.rpdLimit, cp.tpmLimit, cp.tpdLimit,
          cp.maxParallelRequests, nextArchived, nextKeyless, cp.apiFormat,
          existing.id,
        );
        diff.updated++;
        ids?.customProviders.push({ slug: cp.slug, id: existing.id });
      } else {
        // Avoid clashing with built-in platform names — slug uniqueness is
        // also enforced by the schema, but built-ins take priority by
        // registry order, so we should disambiguate explicitly.
        let slug = cp.slug;
        if (hasProvider(asPlatform(slug))) {
          slug = uniqueSlug(db, `${cp.slug}-imported`);
        }
        const result = db.prepare(`
          INSERT INTO custom_providers (slug, display_name, base_url,
            rpm_limit, rpd_limit, tpm_limit, tpd_limit,
            max_parallel_requests, archived, keyless, api_format)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          slug, cp.displayName, normUrl(cp),
          cp.rpmLimit, cp.rpdLimit, cp.tpmLimit, cp.tpdLimit,
          cp.maxParallelRequests, cp.archived ? 1 : 0, cp.keyless ? 1 : 0, cp.apiFormat,
        );
        diff.added++;
        ids?.customProviders.push({ slug, id: Number(result.lastInsertRowid) });
      }
    } catch (err) {
      diff.errors.push(`${cp.slug}: ${(err as Error).message}`);
    }
  }
  summary.custom_providers = diff;
}

// ── Models ────────────────────────────────────────────────────────────────

interface ModelKey { platform: string; modelId: string }

function modelKey(k: ModelKey): string {
  return `${k.platform}\u0000${k.modelId}`;
}
function applyModels(
  db: DatabasePort,
  list: ConfigModel[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
  ids: ConfigImportSummary['ids'],
): { okModels: Map<string, number>; skippedModels: Set<string> } {
  const diff = summary.models ?? emptyDiff();
  if (mode === 'replace') {
    // The export is the authoritative source for the model catalog. Wipe
    // the ENTIRE table (and its dependent fallback_config rows) before
    // re-inserting. M32, documented explicitly: this is a TRUE section
    // wipe — an envelope carrying a partial models list (e.g. 1 model)
    // leaves exactly that model in the destination; every other model,
    // INCLUDING the built-in catalog, is GONE. Operators who want to keep
    // built-ins must export them or use 'overwrite' mode. The
    // fallback_chain section is wiped+rebuilt by its own apply* function;
    // if the operator didn't include it in this import, the chain will be
    // empty (which is the documented behavior of replace mode).
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
  }
  const okModels = new Map<string, number>();
  const skippedModels = new Set<string>();
  for (const m of list) {
    try {
      const key = modelKey(m);
      const existing = db.prepare(
        'SELECT id FROM models WHERE platform = ? AND model_id = ?',
      ).get(m.platform, m.modelId) as { id: number } | undefined;
      if (existing) {
        // Built-in catalog rows are normally read-only on import — but
        // the user can opt in by setting overwriteBuiltin on the record.
        const isBuiltin = hasProvider(asPlatform(m.platform));
        const isLocked = isBuiltin && !m.overwriteBuiltin;
        const isSkipMode = mode === 'skip-existing' && !m.overwriteBuiltin;
        if (isLocked || isSkipMode) {
          // Even when we don't write, register the existing ID so
          // downstream sections (fallback chain, etc.) can resolve
          // the model. Skipping means "leave the row as-is", not
          // "this row doesn't exist on the destination".
          okModels.set(key, existing.id);
          ids?.models.push({ platform: m.platform, modelId: m.modelId, id: existing.id });
          skippedModels.add(key);
          diff.skipped++;
          continue;
        }
        // Compare the current row to the incoming row. If every column
        // already matches, count as skipped — the import is a no-op for
        // this record and the dry-run should reflect that.
        const current = db.prepare(
          `SELECT display_name, intelligence_rank, speed_rank, size_label,
                  rpm_limit, rpd_limit, tpm_limit, tpd_limit,
                  monthly_token_budget, context_window, enabled,
                  supports_vision, max_output_tokens,
                  paid_input_per_m, paid_output_per_m, pricing_manual
           FROM models WHERE id = ?`,
        ).get(existing.id) as {
          display_name: string; intelligence_rank: number; speed_rank: number;
          size_label: string; rpm_limit: number | null; rpd_limit: number | null;
          tpm_limit: number | null; tpd_limit: number | null;
          monthly_token_budget: string; context_window: number | null;
          enabled: number; supports_vision: number;
          max_output_tokens: number | null; paid_input_per_m: number | null;
          paid_output_per_m: number | null; pricing_manual: number;
        };
        const sameAsRow = (a: number | string | null, b: number | string | null): boolean => {
          if (a === b) return true;
          // Treat null/undefined equivalently — both mean "no value".
          if (a == null && b == null) return true;
          if (a == null || b == null) return false;
          return a === b;
        };
        const identical =
          current.display_name === m.displayName &&
          current.intelligence_rank === m.intelligenceRank &&
          current.speed_rank === m.speedRank &&
          current.size_label === m.sizeLabel &&
          sameAsRow(current.rpm_limit, m.rpmLimit) &&
          sameAsRow(current.rpd_limit, m.rpdLimit) &&
          sameAsRow(current.tpm_limit, m.tpmLimit) &&
          sameAsRow(current.tpd_limit, m.tpdLimit) &&
          current.monthly_token_budget === m.monthlyTokenBudget &&
          sameAsRow(current.context_window, m.contextWindow) &&
          current.enabled === (m.enabled ? 1 : 0) &&
          current.supports_vision === (m.supportsVision ? 1 : 0) &&
          sameAsRow(current.max_output_tokens, m.maxOutputTokens) &&
          sameAsRow(current.paid_input_per_m, m.paidInputPerM) &&
          sameAsRow(current.paid_output_per_m, m.paidOutputPerM) &&
          // Marker not yet set → fall through to the UPDATE branch so the
          // imported prices become operator-owned (pricing_manual = 1);
          // otherwise a pre-marker import would keep getting refreshed by
          // release map updates.
          current.pricing_manual === 1;
        if (identical) {
          okModels.set(key, existing.id);
          ids?.models.push({ platform: m.platform, modelId: m.modelId, id: existing.id });
          diff.skipped++;
          continue;
        }
        db.prepare(`
          UPDATE models SET
            display_name = ?, intelligence_rank = ?, speed_rank = ?,
            size_label = ?, rpm_limit = ?, rpd_limit = ?, tpm_limit = ?, tpd_limit = ?,
            monthly_token_budget = ?, context_window = ?, enabled = ?,
            supports_vision = ?, max_output_tokens = ?,
            paid_input_per_m = ?, paid_output_per_m = ?, pricing_manual = 1
          WHERE id = ?
        `).run(
          m.displayName, m.intelligenceRank, m.speedRank,
          m.sizeLabel, m.rpmLimit, m.rpdLimit, m.tpmLimit, m.tpdLimit,
          m.monthlyTokenBudget, m.contextWindow, m.enabled ? 1 : 0,
          m.supportsVision ? 1 : 0, m.maxOutputTokens,
          m.paidInputPerM, m.paidOutputPerM,
          existing.id,
        );
        diff.updated++;
        okModels.set(key, existing.id);
        ids?.models.push({ platform: m.platform, modelId: m.modelId, id: existing.id });
      } else {
        const result = db.prepare(`
          INSERT INTO models (platform, model_id, display_name, intelligence_rank,
            speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
            monthly_token_budget, context_window, enabled, supports_vision,
            max_output_tokens, paid_input_per_m, paid_output_per_m, pricing_manual)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          m.platform, m.modelId, m.displayName, m.intelligenceRank,
          m.speedRank, m.sizeLabel, m.rpmLimit, m.rpdLimit, m.tpmLimit, m.tpdLimit,
          m.monthlyTokenBudget, m.contextWindow, m.enabled ? 1 : 0,
          m.supportsVision ? 1 : 0, m.maxOutputTokens,
          m.paidInputPerM, m.paidOutputPerM,
        );
        diff.added++;
        okModels.set(key, Number(result.lastInsertRowid));
        ids?.models.push({ platform: m.platform, modelId: m.modelId, id: Number(result.lastInsertRowid) });
      }
    } catch (err) {
      diff.errors.push(`${m.platform}/${m.modelId}: ${(err as Error).message}`);
    }
  }
  summary.models = diff;
  return { okModels, skippedModels };
}

// ── API keys ──────────────────────────────────────────────────────────────

function applyApiKeys(
  db: DatabasePort,
  list: ConfigApiKey[],
  keyLookup: Map<string, string> | null,
  legacyPlatformKeys: Map<string, string[]> | null,
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): Array<{ platform: string; label: string; message: string }> {
  // M48: rows rejected for an ENCRYPTION_KEY mismatch are ALSO returned
  // structured, so the summary builder never re-parses human strings.
  const keyMismatchRows: Array<{ platform: string; label: string; message: string }> = [];
  // L44: duplicate (platform,label) rows used to collapse silently — the
  // destination lookup matched one row (LIMIT 1), so which duplicate's
  // enabled/base_url won depended on row order. Reject them up-front with a
  // clear error instead of guessing (throws roll the whole import back).
  const seenKeyRows = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const rowId = `${list[i].platform}\u0000${list[i].label}`;
    if (seenKeyRows.has(rowId)) {
      throw new ConfigImportError(
        `api_keys section contains duplicate (platform, label) rows for '${list[i].platform}' / '${list[i].label}' ` +
        `(envelope entries ${i + 1} and earlier). Give each key a distinct label and re-export.`,
        400,
      );
    }
    seenKeyRows.add(rowId);
  }
  const diff = summary.api_keys ?? emptyDiff();
  const fmtByPlatform = new Map<string, string>();
  const fmtRow = db.prepare('SELECT slug, api_format FROM custom_providers').all() as Array<{ slug: string; api_format: string }>;
  for (const r of fmtRow) fmtByPlatform.set(r.slug, r.api_format ?? 'openai');
  const normKeyUrl = (platform: string, url: string | null | undefined): string | null => {
    if (!url) return null;
    if ((fmtByPlatform.get(platform) ?? 'openai') === 'anthropic') return url.trim().replace(/\/+$/, '');
    return normalizeOpenAiBaseUrl(url);
  };
  if (mode === 'replace') {
    // M32: true section wipe — the export is authoritative for api_keys.
    // Previously only envelope-matching (platform,label) rows were deleted,
    // so destination-only keys silently survived a "replace". Wipe the
    // whole table up front; every envelope row then takes the fresh-insert
    // path below (resets status, created_at, last_checked_at — all runtime
    // state the export doesn't carry). The export's key material is
    // authoritative and the operator is explicitly choosing destructive
    // mode.
    db.prepare('DELETE FROM api_keys').run();
  }
  for (const k of list) {
    try {
      const existing = db.prepare(
        'SELECT id, enabled, base_url FROM api_keys WHERE platform = ? AND label = ? LIMIT 1',
      ).get(k.platform, k.label) as { id: number; enabled: number; base_url: string | null } | undefined;
      if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        if (k.enabled === undefined) { diff.skipped++; continue; }
        // The schema only carries enabled + base_url on the api_keys
        // table from the export; key material is not re-encrypted on
        // import — that's a destructive operation that would silently
        // swap ciphertext on the user. Treat a no-op as skipped.
        const enabledNext = k.enabled ? 1 : 0;
        const baseUrlNext = normKeyUrl(k.platform, k.baseUrl);
        if (existing.enabled === enabledNext && (existing.base_url ?? null) === baseUrlNext) {
          diff.skipped++;
          continue;
        }
        db.prepare('UPDATE api_keys SET enabled = ?, base_url = ? WHERE id = ?')
          .run(enabledNext, baseUrlNext, existing.id);
        diff.updated++;
        continue;
      }
      // Fall through to insert (no existing row; in replace mode the
      // pre-wipe above means every envelope row lands here).
      {
        let encryptedKey: string;
        let iv: string;
        let authTag: string;
        // Resolve this row's plaintext from a passphrase-protected keysCipher
        // when present. The labeled path keys by (platform, label) so each
        // account gets its own key; a multi-key platform is never collapsed
        // to a single shared key the way the old platform-only lookup did.
        let plaintext: string | null = null;
        if (keyLookup) {
          const hit = keyLookup.get(`${k.platform}\u0000${k.label}`);
          if (hit !== undefined) plaintext = hit;
        } else if (legacyPlatformKeys) {
          // Legacy passphrase exports (pre-label payload) cannot map N keys
          // of one platform to their accounts — using any single key for
          // every row is exactly the corruption this fixes — so multi-key
          // legacy platforms fall through to per-row ciphertext instead of
          // guessing. Only a single-key platform is unambiguous.
          const hits = legacyPlatformKeys.get(k.platform);
          if (hits && hits.length === 1) plaintext = hits[0];
        }
        if (plaintext !== null) {
          // The envelope carried a `keysCipher` blob that we successfully
          // decrypted — the operator opted into passphrase-protected
          // transport. The decrypted plaintext is the canonical,
          // transport-independent value for this row; the row's own
          // `encryptedKey / iv / authTag` fields were produced by the source
          // machine's ENCRYPTION_KEY and would silently rot on the
          // destination unless the keys happen to match.
          const enc = encrypt(plaintext);
          encryptedKey = enc.encrypted;
          iv = enc.iv;
          authTag = enc.authTag;
        } else if (k.key) {
          // Plaintext key — re-encrypt under the destination's key.
          const enc = encrypt(k.key);
          encryptedKey = enc.encrypted;
          iv = enc.iv;
          authTag = enc.authTag;
        } else if (k.encryptedKey && k.iv && k.authTag) {
          // Pre-encrypted under the source's ENCRYPTION_KEY. Only safe when
          // the source and destination share a key. Probe with the
          // destination's key first; a GCM auth-tag mismatch means the row
          // would land undecryptable in the DB and break every health check
          // — refuse the row instead of silently corrupting state.
          try {
            decrypt(k.encryptedKey, k.iv, k.authTag);
          } catch {
            const message = `${k.platform}/${k.label}: row is encrypted under a different `
              + `ENCRYPTION_KEY than this gateway. Re-export with a passphrase `
              + `and re-import so the keys travel as a re-encrypted blob.`;
            diff.errors.push(message);
            keyMismatchRows.push({ platform: k.platform, label: k.label, message });
            continue;
          }
          encryptedKey = k.encryptedKey;
          iv = k.iv;
          authTag = k.authTag;
        } else {
          diff.errors.push(`${k.platform}/${k.label}: no key material provided`);
          continue;
        }
        db.prepare(`
          INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
          VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)
        `).run(k.platform, k.label, encryptedKey, iv, authTag, k.enabled ? 1 : 0, normKeyUrl(k.platform, k.baseUrl));
        diff.added++;
      }
    } catch (err) {
      diff.errors.push(`${k.platform}/${k.label}: ${(err as Error).message}`);
    }
  }
  summary.api_keys = diff;
  return keyMismatchRows;
}

// ── Fallback chain ────────────────────────────────────────────────────────

function applyFallbackChain(
  db: DatabasePort,
  list: Array<{ platform: string; modelId: string; priority?: number; enabled: boolean }>,
  okModels: Map<string, number>,
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.fallback_chain ?? emptyDiff();
  if (mode === 'replace') {
    // Wipe first; entries are recomputed from the exported list below.
    db.prepare('DELETE FROM fallback_config').run();
  }
  // Each entry carries its own stored `priority` from the export when
  // available, so a no-op round-trip matches the destination's
  // existing priority exactly — even when two entries share a
  // priority (duplicates are allowed and preserved) or when there
  // are gaps. For envelopes exported by an older version of the
  // gateway (no `priority` field on each entry), we fall back to
  // the 1-based list position, which is what those versions
  // implicitly assumed when reading the chain.
  list.forEach((entry, idx) => {
    try {
      const id = okModels.get(modelKey(entry));
      if (!id) {
        // Model exists in the destination catalog but wasn't part of
        // the export's `models` section (or vice-versa). This is not
        // an error — it just means the fallback entry can't be
        // resolved against the imported list. Count as skipped, do
        // NOT surface as an error.
        diff.skipped++;
        return;
      }
      const nextPriority = entry.priority ?? (idx + 1);
      const enabledNext = entry.enabled ? 1 : 0;
      const existing = db.prepare(
        'SELECT id, priority, enabled FROM fallback_config WHERE model_db_id = ?',
      ).get(id) as { id: number; priority: number; enabled: number } | undefined;
      if (existing) {
        if (existing.priority === nextPriority && existing.enabled === enabledNext) {
          diff.skipped++;
          return;
        }
        db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE id = ?')
          .run(nextPriority, enabledNext, existing.id);
        diff.updated++;
      } else {
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)')
          .run(id, nextPriority, enabledNext);
        diff.added++;
      }
    } catch (err) {
      diff.errors.push(`${entry.platform}/${entry.modelId}: ${(err as Error).message}`);
    }
  });
  summary.fallback_chain = diff;
}

// ── Embeddings ────────────────────────────────────────────────────────────

function applyEmbeddings(
  db: DatabasePort,
  families: ConfigEmbeddingFamily[],
  defaultFamily: string | undefined,
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.embeddings ?? emptyDiff();
  if (mode === 'replace') {
    db.prepare('DELETE FROM embedding_models').run();
  }
  for (const fam of families) {
    if (mode === 'replace') {
      // Insert blindly — the wipe above cleared everything.
      for (const p of fam.providers) {
        db.prepare(`
          INSERT INTO embedding_models (family, platform, model_id, display_name,
            dimensions, max_input_tokens, priority, enabled, quota_label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(fam.family, p.platform, p.modelId, fam.displayName,
          fam.dimensions, fam.maxInputTokens, p.priority, p.enabled ? 1 : 0, fam.quotaLabel);
        diff.added++;
      }
      continue;
    }
    for (const p of fam.providers) {
      try {
        const existing = db.prepare('SELECT id, priority, enabled, dimensions, max_input_tokens, display_name, quota_label FROM embedding_models WHERE family = ? AND platform = ? AND model_id = ?').get(fam.family, p.platform, p.modelId) as {
          id: number; priority: number; enabled: number;
          dimensions: number; max_input_tokens: number | null;
          display_name: string; quota_label: string;
        } | undefined;
        if (existing) {
          if (mode === 'skip-existing') { diff.skipped++; continue; }
          const enabledNext = p.enabled ? 1 : 0;
          const maxInputNext = fam.maxInputTokens;
          const identical =
            existing.priority === p.priority &&
            existing.enabled === enabledNext &&
            existing.dimensions === fam.dimensions &&
            (existing.max_input_tokens ?? null) === (maxInputNext ?? null) &&
            existing.display_name === fam.displayName &&
            existing.quota_label === fam.quotaLabel;
          if (identical) {
            diff.skipped++;
            continue;
          }
          db.prepare(`
            UPDATE embedding_models SET priority = ?, enabled = ?,
              dimensions = ?, max_input_tokens = ?, display_name = ?, quota_label = ?
            WHERE id = ?
          `).run(p.priority, enabledNext, fam.dimensions, maxInputNext, fam.displayName, fam.quotaLabel, existing.id);
          diff.updated++;
        } else {
          db.prepare(`
            INSERT INTO embedding_models (family, platform, model_id, display_name,
              dimensions, max_input_tokens, priority, enabled, quota_label)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fam.family, p.platform, p.modelId, fam.displayName,
            fam.dimensions, fam.maxInputTokens, p.priority, p.enabled ? 1 : 0, fam.quotaLabel);
          diff.added++;
        }
      } catch (err) {
        diff.errors.push(`${fam.family}/${p.platform}/${p.modelId}: ${(err as Error).message}`);
      }
    }
  }
  if (defaultFamily !== undefined) {
    const current = getSetting('embeddings_default_family');
    if (current !== defaultFamily) {
      setSetting('embeddings_default_family', defaultFamily);
      diff.updated++;
    } else {
      diff.skipped++;
    }
  }
  summary.embeddings = diff;
}

// ── Quirks ────────────────────────────────────────────────────────────────

function applyQuirks(
  db: DatabasePort,
  list: ConfigQuirk[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.quirks ?? emptyDiff();
  if (mode === 'replace') {
    db.prepare('DELETE FROM quirk_targets').run();
    db.prepare('DELETE FROM quirks').run();
  }
  const now = Date.now();
  for (const q of list) {
    try {
      const existing = db.prepare(
        'SELECT id, title, body, severity FROM quirks WHERE slug = ?',
      ).get(q.slug) as { id: number; title: string; body: string; severity: string } | undefined;
      let qid: number;
      if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        // Read existing targets so we can detect whether anything
        // actually changed.
        const existingTargets = db.prepare(
          'SELECT platform, model_glob FROM quirk_targets WHERE quirk_id = ? ORDER BY id ASC',
        ).all(existing.id) as Array<{ platform: string | null; model_glob: string | null }>;
        const targetsSame = quirkTargetsEqual(existingTargets, q.targets);
        const fieldsSame =
          existing.title === q.title &&
          existing.body === q.body &&
          existing.severity === q.severity;
        if (fieldsSame && targetsSame) {
          diff.skipped++;
          continue;
        }
        if (!fieldsSame) {
          db.prepare('UPDATE quirks SET title = ?, body = ?, severity = ?, updated_at_ms = ? WHERE id = ?')
            .run(q.title, q.body, q.severity, now, existing.id);
        }
        if (!targetsSame && mode === 'overwrite') {
          db.prepare('DELETE FROM quirk_targets WHERE quirk_id = ?').run(existing.id);
          for (const t of q.targets) {
            db.prepare('INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, ?, ?)')
              .run(existing.id, t.platform, t.modelGlob);
          }
        }
        // For mode=overwrite without target changes, leave the targets
        // table alone. For mode=replace the targets were wiped above
        // and re-inserted.
        diff.updated++;
        qid = existing.id;
      } else {
        const r = db.prepare(
          'INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(q.slug, q.title, q.body, q.severity, now, now);
        qid = Number(r.lastInsertRowid);
        diff.added++;
        for (const t of q.targets) {
          db.prepare('INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, ?, ?)')
            .run(qid, t.platform, t.modelGlob);
        }
      }
    } catch (err) {
      diff.errors.push(`${q.slug}: ${(err as Error).message}`);
    }
  }
  summary.quirks = diff;
}

function quirkTargetsEqual(
  a: Array<{ platform: string | null; model_glob: string | null }>,
  b: Array<{ platform: string | null; modelGlob: string | null }>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const at = a[i];
    const bt = b[i];
    if ((at.platform ?? null) !== (bt.platform ?? null)) return false;
    if ((at.model_glob ?? null) !== (bt.modelGlob ?? null)) return false;
  }
  return true;
}

// ── Client keys ───────────────────────────────────────────────────────────

function applyClientKeys(
  db: DatabasePort,
  list: ConfigClientKey[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.client_keys ?? emptyDiff();
  if (mode === 'replace') {
    // Wipe first so every envelope row takes the fresh-insert path with
    // its exported id preserved verbatim — existing bearer tokens keep
    // authenticating after a restore, and budgets scoped to these ids
    // stay resolvable (budgets are applied after this section).
    db.prepare('DELETE FROM client_keys').run();
  }
  for (const ck of list) {
    try {
      const enabledNext = ck.enabled ? 1 : 0;
      const expiresNext = ck.expiresAtMs ?? null;
      // Stored exactly like the live /api/keys/client writers: the
      // JSON-encoded array, or NULL when unrestricted.
      const allowlistNext =
        ck.modelAllowlist === null || ck.modelAllowlist === undefined
          ? null
          : JSON.stringify(ck.modelAllowlist);
      const rpmNext = ck.rpmOverride ?? null;
      const existing = db.prepare(`
        SELECT secret_hash, salt, label, enabled, expires_at_ms,
               model_allowlist, rpm_override, created_at_ms
        FROM client_keys WHERE id = ?
      `).get(ck.id) as {
        secret_hash: string; salt: string; label: string; enabled: number;
        expires_at_ms: number | null; model_allowlist: string | null;
        rpm_override: number | null; created_at_ms: number;
      } | undefined;
      if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        const identical =
          existing.secret_hash === ck.secretHash &&
          existing.salt === ck.salt &&
          existing.label === ck.label &&
          existing.enabled === enabledNext &&
          (existing.expires_at_ms ?? null) === expiresNext &&
          (existing.model_allowlist ?? null) === allowlistNext &&
          (existing.rpm_override ?? null) === rpmNext &&
          existing.created_at_ms === ck.createdAtMs;
        if (identical) { diff.skipped++; continue; }
        db.prepare(`
          UPDATE client_keys SET secret_hash = ?, salt = ?, label = ?, enabled = ?,
            expires_at_ms = ?, model_allowlist = ?, rpm_override = ?, created_at_ms = ?
          WHERE id = ?
        `).run(ck.secretHash, ck.salt, ck.label, enabledNext, expiresNext,
          allowlistNext, rpmNext, ck.createdAtMs, ck.id);
        diff.updated++;
        continue;
      }
      db.prepare(`
        INSERT INTO client_keys (id, secret_hash, salt, label, enabled,
          expires_at_ms, model_allowlist, rpm_override, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ck.id, ck.secretHash, ck.salt, ck.label, enabledNext,
        expiresNext, allowlistNext, rpmNext, ck.createdAtMs);
      diff.added++;
    } catch (err) {
      diff.errors.push(`${ck.id}: ${(err as Error).message}`);
    }
  }
  summary.client_keys = diff;
}

// ── Budgets ───────────────────────────────────────────────────────────────

function applyBudgets(
  db: DatabasePort,
  list: ConfigBudget[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.budgets ?? emptyDiff();
  if (mode === 'replace') {
    // Limits only — used counters land at their DEFAULT 0 and reset
    // timestamps at NULL, so every restored budget behaves like a fresh
    // one (lazy reset recomputes the windows on first checkAndReserve).
    db.prepare('DELETE FROM budgets').run();
  }
  for (const b of list) {
    try {
      // Normalize the natural key: global budgets always carry NULL
      // scope_id; client_key budgets must reference a key that exists in
      // client_keys AFTER the client-keys section applied (apply()
      // ordering guarantees it ran first). Violations are per-row errors
      // that skip the row without aborting the transaction.
      let scopeId = b.scopeId ?? null;
      if (b.scope === 'client_key') {
        if (!scopeId || !db.prepare('SELECT 1 FROM client_keys WHERE id = ?').get(scopeId)) {
          diff.errors.push(`${b.scope}/${scopeId ?? ''}: scope_id must reference a client key `
            + `defined by this envelope's client_keys section or already present on this gateway`);
          continue;
        }
      } else {
        scopeId = null;
      }
      const dailyNext = b.dailyLimitCents ?? null;
      const weeklyNext = b.weeklyLimitCents ?? null;
      const monthlyNext = b.monthlyLimitCents ?? null;
      const resetDayNext = b.weeklyResetDay ?? 1;
      // UNIQUE(scope, scope_id) cannot dedupe ('global', NULL) rows —
      // SQLite treats NULLs as distinct — so resolve the natural key
      // explicitly with an IS predicate (same as services/budgets.ts).
      // Going through this lookup in EVERY mode (including replace, where
      // any hit is a same-envelope repeat) keeps repeated imports
      // duplicate-free despite the constraint's NULL blind spot.
      const existing = db.prepare(`
        SELECT id, daily_limit_cents, weekly_limit_cents, monthly_limit_cents,
               weekly_reset_day
        FROM budgets WHERE scope = ? AND scope_id IS ?
      `).get(b.scope, scopeId) as {
        id: number; daily_limit_cents: number | null; weekly_limit_cents: number | null;
        monthly_limit_cents: number | null; weekly_reset_day: number | null;
      } | undefined;
      if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        const identical =
          (existing.daily_limit_cents ?? null) === dailyNext &&
          (existing.weekly_limit_cents ?? null) === weeklyNext &&
          (existing.monthly_limit_cents ?? null) === monthlyNext &&
          (existing.weekly_reset_day ?? 1) === resetDayNext;
        if (identical) { diff.skipped++; continue; }
        db.prepare(`
          UPDATE budgets SET daily_limit_cents = ?, weekly_limit_cents = ?,
            monthly_limit_cents = ?, weekly_reset_day = ?
          WHERE id = ?
        `).run(dailyNext, weeklyNext, monthlyNext, resetDayNext, existing.id);
        diff.updated++;
        continue;
      }
      db.prepare(`
        INSERT INTO budgets (scope, scope_id, daily_limit_cents, weekly_limit_cents,
          monthly_limit_cents, weekly_reset_day)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(b.scope, scopeId, dailyNext, weeklyNext, monthlyNext, resetDayNext);
      diff.added++;
    } catch (err) {
      diff.errors.push(`${b.scope}/${b.scopeId ?? ''}: ${(err as Error).message}`);
    }
  }
  summary.budgets = diff;
}

// ── Webhooks ──────────────────────────────────────────────────────────────

function applyWebhooks(
  db: DatabasePort,
  list: ConfigWebhook[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.webhooks ?? emptyDiff();
  if (mode === 'replace') {
    db.prepare('DELETE FROM webhooks').run();
  }
  for (const wh of list) {
    try {
      const enabledNext = wh.enabled ? 1 : 0;
      // url carries no UNIQUE constraint on the table, so existence — not
      // the schema — defines the natural key. Resolving it in EVERY mode
      // (in replace mode a hit is a same-envelope repeat) keeps repeated
      // imports duplicate-free; AUTOINCREMENT assigns fresh ids because
      // the envelope doesn't carry any.
      const existing = db.prepare(
        'SELECT id, secret, events_filter, enabled FROM webhooks WHERE url = ?',
      ).get(wh.url) as {
        id: number; secret: string; events_filter: string; enabled: number;
      } | undefined;
      if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        const identical =
          existing.secret === wh.secret &&
          existing.events_filter === wh.eventsFilter &&
          existing.enabled === enabledNext;
        if (identical) { diff.skipped++; continue; }
        // created_at stays untouched on update — creation metadata, the
        // same way quirks preserve created_at_ms.
        db.prepare('UPDATE webhooks SET secret = ?, events_filter = ?, enabled = ? WHERE id = ?')
          .run(wh.secret, wh.eventsFilter, enabledNext, existing.id);
        diff.updated++;
        continue;
      }
      db.prepare(`
        INSERT INTO webhooks (url, secret, events_filter, enabled, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(wh.url, wh.secret, wh.eventsFilter, enabledNext, wh.createdAtMs ?? Date.now());
      diff.added++;
    } catch (err) {
      diff.errors.push(`${wh.url}: ${(err as Error).message}`);
    }
  }
  summary.webhooks = diff;
}

// L45: per-version migration table — each entry upgrades an envelope FROM
// the keyed version TO key+1, and importing walks forward until it reaches
// CONFIG_SCHEMA_VERSION. Only `current` and `current-1` are supported
// explicitly; anything older is rejected with an upgrade hint. v1 is the
// first schema version so the table is empty today — when
// CONFIG_SCHEMA_VERSION bumps to 2, add `[1]: (env) => ...` here.
const SCHEMA_MIGRATIONS: Record<number, (env: ConfigEnvelope) => ConfigEnvelope> = {};

const OLDEST_IMPORTABLE_SCHEMA_VERSION = Math.max(1, CONFIG_SCHEMA_VERSION - 1);

function migrateEnvelope(env: ConfigEnvelope): ConfigEnvelope {
  let current = env;
  while (current.schemaVersion < CONFIG_SCHEMA_VERSION) {
    const step = SCHEMA_MIGRATIONS[current.schemaVersion];
    if (current.schemaVersion < OLDEST_IMPORTABLE_SCHEMA_VERSION || !step) {
      throw new ConfigImportError(
        `Envelope schemaVersion ${current.schemaVersion} is too old — this server imports schemaVersion ` +
        `${OLDEST_IMPORTABLE_SCHEMA_VERSION} through ${CONFIG_SCHEMA_VERSION}. Re-export the config with a newer gateway.`,
        400,
      );
    }
    current = { ...step(current), schemaVersion: current.schemaVersion + 1 };
  }
  return current;
}

// ── Entry point ───────────────────────────────────────────────────────────

export interface RunImportOptions {
  envelope: unknown;
  options?: Partial<ConfigImportOptions>;
}

export interface RunImportResult extends ConfigImportSummary {
  // Echoed for the UI: the parsed options the import actually used.
  effectiveOptions: ConfigImportOptions;
}

export function runImport({ envelope, options }: RunImportOptions): RunImportResult {
  const parsedEnvelope = configEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    throw new ConfigImportError(
      `Invalid envelope: ${parsedEnvelope.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')}`,
      400,
    );
  }
  // L45: newer versions are rejected outright; older ones go through the
  // explicit migration walk above (current and current-1 only).
  if ((parsedEnvelope.data as ConfigEnvelope).schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new ConfigImportError(
      `Envelope schemaVersion ${(parsedEnvelope.data as ConfigEnvelope).schemaVersion} is newer than this server supports (${CONFIG_SCHEMA_VERSION}). Upgrade the gateway to import this file.`,
      400,
    );
  }
  const env = migrateEnvelope(parsedEnvelope.data as ConfigEnvelope);
  const warnings: string[] = [];
  if (env.generator !== CONFIG_GENERATOR) {
    // Foreign file: not fatal (we accept third-party envelopes — forward-compat),
    // but the operator should see what they're importing.
    warnings.push(
      `Envelope was generated by '${env.generator}'; expected '${CONFIG_GENERATOR}'. ` +
      `Field semantics may differ — review the imported values before relying on them.`,
    );
  }

  const parsedOptions = configImportOptionsSchema.safeParse(options ?? {});
  if (!parsedOptions.success) {
    throw new ConfigImportError(
      `Invalid import options: ${parsedOptions.error.errors.map((e) => e.message).join('; ')}`,
      400,
    );
  }
  const eff: ConfigImportOptions = parsedOptions.data;
  const sectionAllow = new Set(eff.sections ?? [
    'models', 'fallback_chain', 'custom_providers', 'api_keys',
    'client_keys', 'budgets', 'webhooks', 'embeddings', 'settings', 'quirks',
  ]);

  // Decrypt the keysCipher blob up-front (if any) — outside the
  // transaction because PBKDF2 is slow and we want any wrong-passphrase
  // error surfaced before we start mutating.
  // `platform${platform}\u0000${label}` -> plaintext key, or legacy fallback.
  let keyLookup: Map<string, string> | null = null;         // `${platform}\u0000${label}` -> key
  let legacyPlatformKeys: Map<string, string[]> | null = null; // legacy: platform -> keys
  if (env.keysCipher) {
    if (!eff.passphrase) {
      throw new ConfigImportError(
        'envelope contains a keysCipher blob but no passphrase was supplied',
        400,
      );
    }
    let decrypted: Array<{ platform: string; label?: string; key: string }>;
    try {
      decrypted = decryptKeysWithPassphrase(env.keysCipher, eff.passphrase);
    } catch {
      throw new ConfigImportError(
        'could not decrypt keysCipher — wrong passphrase or corrupted blob',
        401,
      );
    }
    // An export written by this gateway labels every keysCipher entry, so a
    // round-trip matches each account row exactly by (platform, label).
    // Legacy passphrase exports have no labels and can only ever be applied
    // whole-platform (see applyApiKeys' legacy branch for the multi-key case).
    const allLabeled = decrypted.length > 0 && decrypted.every((d) => typeof d.label === 'string' && d.label.length > 0);
    if (allLabeled) {
      keyLookup = new Map(decrypted.map((d) => [`${d.platform}\u0000${d.label}` , d.key]));
    } else {
      legacyPlatformKeys = new Map<string, string[]>();
      for (const d of decrypted) {
        const arr = legacyPlatformKeys.get(d.platform) ?? [];
        arr.push(d.key);
        legacyPlatformKeys.set(d.platform, arr);
      }
    }
  }

  const db = getDb();
  const summary: Record<string, SectionDiff> = {};
  const ids: ConfigImportSummary['ids'] = { models: [], customProviders: [] };
  // M48: structured ENCRYPTION_KEY-mismatch rows, collected by applyApiKeys
  // inside the transaction and consumed by the keyCompatibility summary.
  let apiKeysMismatchRows: Array<{ platform: string; label: string; message: string }> = [];

  // Apply everything inside a single transaction. The savepoint pattern
  // (SAVEPOINT → work → RELEASE on success, ROLLBACK on dryRun) keeps
  // the diff calculation atomic with the commit.
  const apply = db.transaction(() => {
    if (sectionAllow.has('settings') && env.sections.settings) {
      const sd = summary.settings ?? emptyDiff();
      applySettings(db, env.sections.settings, sd);
      summary.settings = sd;
    }

    // custom_providers must come BEFORE models — a model referencing a
    // custom slug doesn't have a FK enforcement (only platform is a
    // string), but a separate step keeps ordering explicit and matches
    // the route's natural sequence.
    if (sectionAllow.has('custom_providers') && env.sections.customProviders) {
      applyCustomProviders(db, env.sections.customProviders, eff.mode, summary, ids);
    }

    let modelResolution: { okModels: Map<string, number>; skippedModels: Set<string> } = {
      okModels: new Map(), skippedModels: new Set(),
    };
    if (sectionAllow.has('models') && env.sections.models) {
      modelResolution = applyModels(db, env.sections.models, eff.mode, summary, ids);
    }

    if (sectionAllow.has('fallback_chain') && env.sections.fallbackChain) {
      applyFallbackChain(db, env.sections.fallbackChain, modelResolution.okModels, eff.mode, summary);
    }

    if (sectionAllow.has('api_keys') && env.sections.apiKeys) {
      apiKeysMismatchRows = applyApiKeys(db, env.sections.apiKeys, keyLookup, legacyPlatformKeys, eff.mode, summary);
    }

    // F3/F4/F8 backup-restore sections. client_keys MUST precede budgets —
    // budget rows scoped to a key validate scope_id against the
    // post-import client_keys table.
    if (sectionAllow.has('client_keys') && env.sections.clientKeys) {
      applyClientKeys(db, env.sections.clientKeys, eff.mode, summary);
    }

    if (sectionAllow.has('budgets') && env.sections.budgets) {
      applyBudgets(db, env.sections.budgets, eff.mode, summary);
    }

    if (sectionAllow.has('webhooks') && env.sections.webhooks) {
      applyWebhooks(db, env.sections.webhooks, eff.mode, summary);
    }



    if (sectionAllow.has('embeddings') && env.sections.embeddings) {
      applyEmbeddings(
        db,
        env.sections.embeddings.families,
        env.sections.embeddings.defaultFamily,
        eff.mode,
        summary,
      );
    }

    if (sectionAllow.has('quirks') && env.sections.quirks) {
      applyQuirks(db, env.sections.quirks, eff.mode, summary);
    }
  });

  if (eff.dryRun) {
    // Run inside a savepoint so the work rolls back. The database port
    // does not expose SAVEPOINT as a method, so we drive it via raw SQL.
    const spName = `import_dryrun_${Date.now()}`;
    db.exec(`SAVEPOINT ${spName}`);
    try {
      apply();
      db.exec(`ROLLBACK TO ${spName}`);
      db.exec(`RELEASE ${spName}`);
    } catch (err) {
      try { db.exec(`ROLLBACK TO ${spName}`); db.exec(`RELEASE ${spName}`); }
      catch { /* best-effort */ }
      throw err;
    }
  } else {
    apply();
  }

  // Build the post-import key compatibility summary. Counts every error
  // in the api_keys section that the per-row safety net pushed with
  // the canonical "different ENCRYPTION_KEY" message — that's the
  // single signal the UI banner needs to render a clear remediation
  // without forcing the operator to open the error details panel.
  const apiKeysDiff = summary.api_keys;
  // M48: use the STRUCTURED mismatch rows threaded out of applyApiKeys —
  // no regex re-parsing of human-formatted error strings (labels may
  // contain ':' and platforms '/').
  const keyMismatchRows = apiKeysMismatchRows;
  const keyCompatibility: ConfigImportSummary['keyCompatibility'] = apiKeysDiff && (apiKeysDiff.added + apiKeysDiff.updated + apiKeysDiff.skipped + keyMismatchRows.length) > 0
    ? {
        // Status reflects the most pessimistic outcome observed. A
        // mismatch after a probe says "mismatch"; if any rows came in
        // cleanly but others didn't, that's still "mismatch" overall
        // because the operator must re-export with a passphrase to
        // recover the failing ones.
        status: ((): ConfigKeyCompatibility => {
          if (env.keysCipher) return 'encrypted-with-passphrase';
          if (keyMismatchRows.length > 0) return 'mismatch';
          // No mismatch errors — re-derive the verdict from a cheap
          // probe so the banner explains why the import worked even
          // when the operator didn't supply a passphrase.
          return probeKeyCompatibility(env);
        })(),
        totalRows: env.sections.apiKeys?.length ?? 0,
        skippedDueToMismatch: keyMismatchRows.length,
        sampleFailure: keyMismatchRows[0] ? {
          platform: keyMismatchRows[0].platform,
          label: keyMismatchRows[0].label,
          message: keyMismatchRows[0].message,
        } : undefined,
      }
    : undefined;

  return {
    dryRun: eff.dryRun,
    mode: eff.mode,
    importedAt: new Date().toISOString(),
    sections: summary,
    ids,
    effectiveOptions: eff,
    keyCompatibility,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Parse + validate an envelope without applying anything. Returns either
 * a summary of what the envelope contains or a validation error. Used by
 * the Settings UI's "preview" workflow.
 */
export function previewEnvelope(envelope: unknown): {
  envelope: ConfigEnvelope;
  sections: Record<ConfigSection, number>;
  keyCompatibility: ConfigKeyCompatibility;
} {
  const parsed = configEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ConfigImportError(
      `Invalid envelope: ${parsed.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')}`,
      400,
    );
  }
  const env = parsed.data as ConfigEnvelope;
  const counts: Record<ConfigSection, number> = {
    models: env.sections.models?.length ?? 0,
    fallback_chain: env.sections.fallbackChain?.length ?? 0,
    custom_providers: env.sections.customProviders?.length ?? 0,
    api_keys: env.sections.apiKeys?.length ?? 0,
    client_keys: env.sections.clientKeys?.length ?? 0,
    budgets: env.sections.budgets?.length ?? 0,
    webhooks: env.sections.webhooks?.length ?? 0,
    embeddings: env.sections.embeddings?.families.length ?? 0,
    settings: env.sections.settings ? 1 : 0,
    quirks: env.sections.quirks?.length ?? 0,
  };
  return { envelope: env, sections: counts, keyCompatibility: probeKeyCompatibility(env) };
}
