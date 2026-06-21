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
import type Database from 'better-sqlite3';
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
} from '@api-gateway/shared';
import { configEnvelopeSchema, configImportOptionsSchema } from './schema.js';
import { decryptKeysWithPassphrase } from './passphrase-crypto.js';

// Sentinel substring used by the per-row safety net inside applyApiKeys
// when a row's source ciphertext doesn't decrypt under the destination's
// ENCRYPTION_KEY. The post-import banner in runImport and the preview
// probe both key off this single phrase so the UI banner, the error
// details panel, and the test expectations stay in lockstep.
const KEY_MISMATCH_ERROR_RE =
  /row is encrypted under a different ENCRYPTION_KEY than this gateway/;

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

function uniqueSlug(db: Database.Database, base: string): string {
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

function applySettings(db: Database.Database, settings: ConfigSettings, diff: SectionDiff): void {
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
}

// ── Custom providers ──────────────────────────────────────────────────────

function applyCustomProviders(
  db: Database.Database,
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
    const slugs = list.map((cp) => cp.slug);
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
        const sameAsRow = (a: number | string | null, b: number | string | null): boolean => {
          if (a === b) return true;
          if (a == null && b == null) return true;
          if (a == null || b == null) return false;
          return a === b;
        };
        const identical =
          existing.display_name === cp.displayName &&
          existing.base_url === cp.baseUrl &&
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
          cp.displayName, cp.baseUrl,
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
          slug, cp.displayName, cp.baseUrl,
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
  db: Database.Database,
  list: ConfigModel[],
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
  ids: ConfigImportSummary['ids'],
): { okModels: Map<string, number>; skippedModels: Set<string> } {
  const diff = summary.models ?? emptyDiff();
  if (mode === 'replace') {
    // The export is the authoritative source for the model catalog. Wipe
    // the entire table (and its dependent fallback_config rows) before
    // re-inserting. The fallback_chain section is wiped+rebuilt by its
    // own apply* function; if the operator didn't include it in this
    // import, the chain will be empty (which is the documented
    // behavior of replace mode).
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
                  supports_vision, supports_tools, max_output_tokens,
                  paid_input_per_m, paid_output_per_m
           FROM models WHERE id = ?`,
        ).get(existing.id) as {
          display_name: string; intelligence_rank: number; speed_rank: number;
          size_label: string; rpm_limit: number | null; rpd_limit: number | null;
          tpm_limit: number | null; tpd_limit: number | null;
          monthly_token_budget: string; context_window: number | null;
          enabled: number; supports_vision: number; supports_tools: number;
          max_output_tokens: number | null; paid_input_per_m: number | null;
          paid_output_per_m: number | null;
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
          current.supports_tools === (m.supportsTools ? 1 : 0) &&
          sameAsRow(current.max_output_tokens, m.maxOutputTokens) &&
          sameAsRow(current.paid_input_per_m, m.paidInputPerM) &&
          sameAsRow(current.paid_output_per_m, m.paidOutputPerM);
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
            supports_vision = ?, supports_tools = ?, max_output_tokens = ?,
            paid_input_per_m = ?, paid_output_per_m = ?
          WHERE id = ?
        `).run(
          m.displayName, m.intelligenceRank, m.speedRank,
          m.sizeLabel, m.rpmLimit, m.rpdLimit, m.tpmLimit, m.tpdLimit,
          m.monthlyTokenBudget, m.contextWindow, m.enabled ? 1 : 0,
          m.supportsVision ? 1 : 0, m.supportsTools ? 1 : 0, m.maxOutputTokens,
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
            supports_tools, max_output_tokens, paid_input_per_m, paid_output_per_m)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          m.platform, m.modelId, m.displayName, m.intelligenceRank,
          m.speedRank, m.sizeLabel, m.rpmLimit, m.rpdLimit, m.tpmLimit, m.tpdLimit,
          m.monthlyTokenBudget, m.contextWindow, m.enabled ? 1 : 0,
          m.supportsVision ? 1 : 0, m.supportsTools ? 1 : 0, m.maxOutputTokens,
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
  db: Database.Database,
  list: ConfigApiKey[],
  keysByPlatform: Map<string, string> | null,
  mode: ConfigImportOptions['mode'],
  summary: Record<string, SectionDiff>,
): void {
  const diff = summary.api_keys ?? emptyDiff();
  const inReplace = mode === 'replace';
  for (const k of list) {
    try {
      const existing = db.prepare(
        'SELECT id, enabled, base_url FROM api_keys WHERE platform = ? AND label = ? LIMIT 1',
      ).get(k.platform, k.label) as { id: number; enabled: number; base_url: string | null } | undefined;
      if (existing && inReplace) {
        // In replace mode, drop the existing row so the re-insert starts
        // fresh (resets status, created_at, last_checked_at — all runtime
        // state the export doesn't carry). We also don't try to preserve
        // the old ciphertext: the export's key material is authoritative
        // and the operator is explicitly choosing destructive mode.
        // Fall through to the insert path below.
        db.prepare('DELETE FROM api_keys WHERE id = ?').run(existing.id);
      } else if (existing) {
        if (mode === 'skip-existing') { diff.skipped++; continue; }
        if (k.enabled === undefined) { diff.skipped++; continue; }
        // The schema only carries enabled + base_url on the api_keys
        // table from the export; key material is not re-encrypted on
        // import — that's a destructive operation that would silently
        // swap ciphertext on the user. Treat a no-op as skipped.
        const enabledNext = k.enabled ? 1 : 0;
        const baseUrlNext = k.baseUrl ?? null;
        if (existing.enabled === enabledNext && (existing.base_url ?? null) === baseUrlNext) {
          diff.skipped++;
          continue;
        }
        db.prepare('UPDATE api_keys SET enabled = ?, base_url = ? WHERE id = ?')
          .run(enabledNext, baseUrlNext, existing.id);
        diff.updated++;
        continue;
      }
      // Fall through to insert (no existing row, OR replace-mode wipe just removed it).
      {
        let encryptedKey: string;
        let iv: string;
        let authTag: string;
        if (keysByPlatform?.has(k.platform)) {
          // The envelope carried a `keysCipher` blob that we successfully
          // decrypted — the operator opted into passphrase-protected
          // transport. The plaintext in `keysByPlatform` is the canonical,
          // transport-independent value for every row at that platform; the
          // `encryptedKey / iv / authTag` fields on this row were produced
          // by the source machine's ENCRYPTION_KEY and will silently rot on
          // the destination unless the keys happen to match. Always prefer
          // the decrypted plaintext here so cross-machine restores work as
          // long as the operator passed the correct passphrase.
          const enc = encrypt(keysByPlatform.get(k.platform) as string);
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
            diff.errors.push(
              `${k.platform}/${k.label}: row is encrypted under a different `
              + `ENCRYPTION_KEY than this gateway. Re-export with a passphrase `
              + `and re-import so the keys travel as a re-encrypted blob.`,
            );
            continue;
          }
          encryptedKey = k.encryptedKey;
          iv = k.iv;
          authTag = k.authTag;
        } else if (k.key) {
          const enc = encrypt(k.key);
          encryptedKey = enc.encrypted;
          iv = enc.iv;
          authTag = enc.authTag;
        } else {
          diff.errors.push(`${k.platform}/${k.label}: no key material provided`);
          continue;
        }
        db.prepare(`
          INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
          VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)
        `).run(k.platform, k.label, encryptedKey, iv, authTag, k.enabled ? 1 : 0, k.baseUrl ?? null);
        diff.added++;
      }
    } catch (err) {
      diff.errors.push(`${k.platform}/${k.label}: ${(err as Error).message}`);
    }
  }
  summary.api_keys = diff;
}

// ── Fallback chain ────────────────────────────────────────────────────────

function applyFallbackChain(
  db: Database.Database,
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
  db: Database.Database,
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
  db: Database.Database,
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
  const env = parsedEnvelope.data as ConfigEnvelope;
  if (env.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new ConfigImportError(
      `Envelope schemaVersion ${env.schemaVersion} is newer than this server supports (${CONFIG_SCHEMA_VERSION}). Upgrade the gateway to import this file.`,
      400,
    );
  }
  if (env.generator !== CONFIG_GENERATOR) {
    // Not fatal — we accept third-party files — but worth surfacing.
    // No-op here; the response's `effectiveOptions` could carry a note in
    // future revisions.
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
    'models', 'fallback_chain', 'custom_providers', 'api_keys', 'embeddings', 'settings', 'quirks',
  ]);

  // Decrypt the keysCipher blob up-front (if any) — outside the
  // transaction because PBKDF2 is slow and we want any wrong-passphrase
  // error surfaced before we start mutating.
  let keysByPlatform: Map<string, string> | null = null;
  if (env.keysCipher) {
    if (!eff.passphrase) {
      throw new ConfigImportError(
        'envelope contains a keysCipher blob but no passphrase was supplied',
        400,
      );
    }
    let decrypted: Array<{ platform: string; key: string }>;
    try {
      decrypted = decryptKeysWithPassphrase(env.keysCipher, eff.passphrase);
    } catch {
      throw new ConfigImportError(
        'could not decrypt keysCipher — wrong passphrase or corrupted blob',
        401,
      );
    }
    keysByPlatform = new Map(decrypted.map((d) => [d.platform, d.key]));
  }

  const db = getDb();
  const summary: Record<string, SectionDiff> = {};
  const ids: ConfigImportSummary['ids'] = { models: [], customProviders: [] };

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
      applyApiKeys(db, env.sections.apiKeys, keysByPlatform, eff.mode, summary);
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
    // Run inside a savepoint so the work rolls back. better-sqlite3
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
  const mismatchErrors = apiKeysDiff?.errors.filter((e) => KEY_MISMATCH_ERROR_RE.test(e)) ?? [];
  const keyCompatibility: ConfigImportSummary['keyCompatibility'] = apiKeysDiff && (apiKeysDiff.added + apiKeysDiff.updated + apiKeysDiff.skipped + mismatchErrors.length) > 0
    ? {
        // Status reflects the most pessimistic outcome observed. A
        // mismatch after a probe says "mismatch"; if any rows came in
        // cleanly but others didn't, that's still "mismatch" overall
        // because the operator must re-export with a passphrase to
        // recover the failing ones.
        status: ((): ConfigKeyCompatibility => {
          if (env.keysCipher) return 'encrypted-with-passphrase';
          if (mismatchErrors.length > 0) return 'mismatch';
          // No mismatch errors — re-derive the verdict from a cheap
          // probe so the banner explains why the import worked even
          // when the operator didn't supply a passphrase.
          return probeKeyCompatibility(env);
        })(),
        totalRows: env.sections.apiKeys?.length ?? 0,
        skippedDueToMismatch: mismatchErrors.length,
        sampleFailure: mismatchErrors[0] ? {
          platform: (mismatchErrors[0].match(/^([^/]+)\/[^:]+:/) ?? [, ''])[1],
          label: (mismatchErrors[0].match(/^[^/]+\/([^:]+):/) ?? [, ''])[1],
          message: mismatchErrors[0],
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
    embeddings: env.sections.embeddings?.families.length ?? 0,
    settings: env.sections.settings ? 1 : 0,
    quirks: env.sections.quirks?.length ?? 0,
  };
  return { envelope: env, sections: counts, keyCompatibility: probeKeyCompatibility(env) };
}
