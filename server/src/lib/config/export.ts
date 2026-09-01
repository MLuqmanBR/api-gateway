// Config export service. Snapshots the user's full configuration into a
// versioned, importable envelope. All reads happen in a single read
// transaction so the export is internally consistent: a model and its
// fallback entry, an api_key and the row that decrypts it, etc., will not
// race against a concurrent write.
//
// The optional `passphrase` encrypts the api_keys payload (only) into a
// self-describing cipher blob. Without a passphrase every DECRYPTABLE key
// is embedded in cleartext by design — the backup restores on any host,
// with no ENCRYPTION_KEY dependency — while rows whose ciphertext failed
// to decrypt keep their ciphertext fields only.
import type { DatabasePort } from '../../db/types.js';
import { getDb } from '../../db/index.js';
import { decrypt } from '../crypto.js';
import {
  CONFIG_SCHEMA_VERSION,
  CONFIG_GENERATOR,
  type ConfigEnvelope,
  type ConfigSection,
  type ConfigModel,
  type ConfigFallbackEntry,
  type ConfigCustomProvider,
  type ConfigApiKey,
  type ConfigClientKey,
  type ConfigBudget,
  type ConfigWebhook,
  type ConfigSettings,
  type ConfigQuirk,
  type ConfigEmbeddingFamily,
  type ConfigTranscriptionFamily,
  type ConfigExportRequest,
} from '@api-gateway/shared';
import { encryptKeysWithPassphrase } from './passphrase-crypto.js';

export interface BuildExportOptions {
  sections?: ConfigSection[];
  passphrase?: string;
  label?: string;
}
const ALL_SECTIONS: ConfigSection[] = [
  'models', 'fallback_chain', 'custom_providers', 'api_keys',
  'client_keys', 'budgets', 'webhooks',
  'embeddings', 'transcriptions', 'settings', 'quirks',
];

function sectionSet(sections?: ConfigSection[]): Record<ConfigSection, true> {
  const keys = sections && sections.length > 0 ? sections : ALL_SECTIONS;
  const out = {} as Record<ConfigSection, true>;
  for (const k of keys) out[k] = true;
  return out;
}

export class ConfigExportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = 'ConfigExportError';
  }
}

function readSection(db: DatabasePort, sections: Record<ConfigSection, true>): ConfigEnvelope['sections'] {
  const out: ConfigEnvelope['sections'] = {};
  const tx = db.transaction(() => {
    if (sections.models) {
      const rows = db.prepare(`
        SELECT platform, model_id, display_name, intelligence_rank, speed_rank,
               size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
               monthly_token_budget, context_window, enabled, supports_vision,
               max_output_tokens, paid_input_per_m, paid_output_per_m
        FROM models
      `).all() as Array<{
        platform: string; model_id: string; display_name: string;
        intelligence_rank: number; speed_rank: number; size_label: string;
        rpm_limit: number | null; rpd_limit: number | null;
        tpm_limit: number | null; tpd_limit: number | null;
        monthly_token_budget: string; context_window: number | null;
        enabled: number; supports_vision: number;
        max_output_tokens: number | null;
        paid_input_per_m: number | null; paid_output_per_m: number | null;
      }>;
      out.models = rows.map<ConfigModel>((r) => ({
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        intelligenceRank: r.intelligence_rank,
        speedRank: r.speed_rank,
        sizeLabel: r.size_label,
        rpmLimit: r.rpm_limit,
        rpdLimit: r.rpd_limit,
        tpmLimit: r.tpm_limit,
        tpdLimit: r.tpd_limit,
        monthlyTokenBudget: r.monthly_token_budget,
        contextWindow: r.context_window,
        enabled: r.enabled === 1,
        supportsVision: r.supports_vision === 1,
        maxOutputTokens: r.max_output_tokens,
        paidInputPerM: r.paid_input_per_m,
        paidOutputPerM: r.paid_output_per_m,
      }));
    }

    if (sections.fallback_chain) {
      // Tie-break by `model_db_id` so the export order is stable even
      // when two rows share a priority (which happens after manual
      // edits or when a model is re-inserted at the tail). The
      // stored `priority` is preserved verbatim in each entry so a
      // no-op round-trip can compare it directly without inferring
      // it from the list index.
      const rows = db.prepare(`
        SELECT m.platform, m.model_id, fc.id AS fallback_id,
               fc.priority, fc.enabled
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
        ORDER BY fc.priority ASC, fc.id ASC
      `).all() as Array<{
        platform: string; model_id: string; fallback_id: number;
        priority: number; enabled: number;
      }>;
      out.fallbackChain = rows.map<ConfigFallbackEntry>((r) => ({
        platform: r.platform,
        modelId: r.model_id,
        priority: r.priority,
        enabled: r.enabled === 1,
      }));
    }

    if (sections.custom_providers) {
      const rows = db.prepare(`
        SELECT slug, display_name, base_url, rpm_limit, rpd_limit, tpm_limit,
               tpd_limit, max_parallel_requests, archived, keyless, api_format
        FROM custom_providers
      `).all() as Array<{
        slug: string; display_name: string; base_url: string;
        rpm_limit: number | null; rpd_limit: number | null;
        tpm_limit: number | null; tpd_limit: number | null;
        max_parallel_requests: number | null;
        archived: number | null; keyless: number | null;
        api_format: string | null;
      }>;
      out.customProviders = rows.map<ConfigCustomProvider>((r) => ({
        slug: r.slug,
        displayName: r.display_name,
        baseUrl: r.base_url,
        rpmLimit: r.rpm_limit,
        rpdLimit: r.rpd_limit,
        tpmLimit: r.tpm_limit,
        tpdLimit: r.tpd_limit,
        maxParallelRequests: r.max_parallel_requests,
        archived: (r.archived ?? 0) === 1,
        keyless: (r.keyless ?? 0) === 1,
        apiFormat: (r.api_format === 'anthropic' ? 'anthropic' : 'openai'),
      }));
    }

    if (sections.api_keys) {
      const rows = db.prepare(`
        SELECT platform, label, encrypted_key, iv, auth_tag, enabled, base_url
        FROM api_keys
      `).all() as Array<{
        platform: string; label: string; encrypted_key: string; iv: string;
        auth_tag: string; enabled: number; base_url: string | null;
      }>;
      // Policy: every DECRYPTABLE key carries its plaintext `key` in the
      // envelope (machine-independent backups). With a passphrase,
      // buildExport moves the plaintext into keysCipher and strips the
      // row-level key fields below. Rows whose ciphertext failed to
      // decrypt keep only their encryptedKey/iv/authTag fields.
      out.apiKeys = rows.map<ConfigApiKey>((r) => {
        let plaintext: string | null = null;
        try {
          plaintext = decrypt(r.encrypted_key, r.iv, r.auth_tag);
        } catch {
          // Decryption failure shouldn't fail the whole export — the
          // user can still back up everything else. The row keeps its
          // ciphertext fields so an import on the same ENCRYPTION_KEY
          // can recover it; on a different host it will be skipped.
          plaintext = null;
        }
        return {
          platform: r.platform,
          label: r.label,
          enabled: r.enabled === 1,
          key: plaintext ?? undefined,
          encryptedKey: r.encrypted_key,
          iv: r.iv,
          authTag: r.auth_tag,
          baseUrl: r.base_url,
        };
      });
    }

    if (sections.client_keys) {
      // created_at_ms ordering (id as deterministic tie-break) keeps
      // repeated exports of unchanged rows byte-identical.
      const rows = db.prepare(`
        SELECT id, secret_hash, salt, label, enabled, expires_at_ms,
               model_allowlist, rpm_override, created_at_ms
        FROM client_keys
        ORDER BY created_at_ms ASC, id ASC
      `).all() as Array<{
        id: string; secret_hash: string; salt: string; label: string;
        enabled: number; expires_at_ms: number | null;
        model_allowlist: string | null; rpm_override: number | null;
        created_at_ms: number;
      }>;
      out.clientKeys = rows.map<ConfigClientKey>((r) => {
        let modelAllowlist: string[] | null = null;
        if (r.model_allowlist !== null) {
          try {
            modelAllowlist = JSON.parse(r.model_allowlist);
          } catch {
            modelAllowlist = null;
          }
        }
        return {
          id: r.id,
          secretHash: r.secret_hash,
          salt: r.salt,
          label: r.label,
          enabled: r.enabled === 1,
          expiresAtMs: r.expires_at_ms,
          modelAllowlist,
          rpmOverride: r.rpm_override,
          createdAtMs: r.created_at_ms,
        };
      });
    }

    if (sections.budgets) {
      // Limits only — daily/weekly/monthly used counters and reset
      // timestamps are runtime state and never exported.
      const rows = db.prepare(`
        SELECT scope, scope_id, daily_limit_cents, weekly_limit_cents,
               monthly_limit_cents, weekly_reset_day
        FROM budgets
        ORDER BY scope ASC, scope_id ASC
      `).all() as Array<{
        scope: string; scope_id: string | null;
        daily_limit_cents: number | null; weekly_limit_cents: number | null;
        monthly_limit_cents: number | null; weekly_reset_day: number | null;
      }>;
      out.budgets = rows.map<ConfigBudget>((r) => ({
        scope: r.scope as ConfigBudget['scope'],
        scopeId: r.scope_id,
        dailyLimitCents: r.daily_limit_cents,
        weeklyLimitCents: r.weekly_limit_cents,
        monthlyLimitCents: r.monthly_limit_cents,
        weeklyResetDay: r.weekly_reset_day,
      }));
    }

    if (sections.webhooks) {
      const rows = db.prepare(`
        SELECT url, secret, events_filter, enabled, created_at
        FROM webhooks
        ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        url: string; secret: string; events_filter: string;
        enabled: number; created_at: number;
      }>;
      out.webhooks = rows.map<ConfigWebhook>((r) => ({
        url: r.url,
        secret: r.secret,
        eventsFilter: r.events_filter,
        enabled: r.enabled === 1,
        createdAtMs: r.created_at,
      }));
    }

    if (sections.embeddings) {
      const defaultFamily = db.prepare(
        "SELECT value FROM settings WHERE key = 'embeddings_default_family'",
      ).get() as { value: string } | undefined;
      const familyRows = db.prepare(`
        SELECT family, platform, model_id, display_name, dimensions,
               max_input_tokens, priority, enabled, quota_label
        FROM embedding_models
        ORDER BY family ASC, priority ASC
      `).all() as Array<{
        family: string; platform: string; model_id: string;
        display_name: string; dimensions: number;
        max_input_tokens: number | null; priority: number;
        enabled: number; quota_label: string;
      }>;
      const byFamily = new Map<string, ConfigEmbeddingFamily>();
      for (const r of familyRows) {
        let fam = byFamily.get(r.family);
        if (!fam) {
          fam = {
            family: r.family,
            providers: [],
            dimensions: r.dimensions,
            maxInputTokens: r.max_input_tokens,
            displayName: r.display_name,
            quotaLabel: r.quota_label,
          };
          byFamily.set(r.family, fam);
        }
        fam.providers.push({
          platform: r.platform,
          modelId: r.model_id,
          priority: r.priority,
          enabled: r.enabled === 1,
        });
      }
      out.embeddings = {
        defaultFamily: defaultFamily?.value,
        families: Array.from(byFamily.values()),
      };
    }

    if (sections.transcriptions) {
      const defaultFamily = db.prepare(
        "SELECT value FROM settings WHERE key = 'transcriptions_default_family'",
      ).get() as { value: string } | undefined;
      const familyRows = db.prepare(`
        SELECT family, platform, model_id, display_name, max_file_mb,
               supports_translations, price_per_hour_usd, priority, enabled, quota_label
        FROM transcription_models
        ORDER BY family ASC, priority ASC
      `).all() as Array<{
        family: string; platform: string; model_id: string;
        display_name: string; max_file_mb: number;
        supports_translations: number; price_per_hour_usd: number | null;
        priority: number; enabled: number; quota_label: string;
      }>;
      const byFamily = new Map<string, ConfigTranscriptionFamily>();
      for (const r of familyRows) {
        let fam = byFamily.get(r.family);
        if (!fam) {
          fam = {
            family: r.family,
            providers: [],
            maxFileMb: r.max_file_mb,
            supportsTranslations: r.supports_translations === 1,
            displayName: r.display_name,
            quotaLabel: r.quota_label,
          };
          byFamily.set(r.family, fam);
        }
        fam.providers.push({
          platform: r.platform,
          modelId: r.model_id,
          priority: r.priority,
          enabled: r.enabled === 1,
          pricePerHourUsd: r.price_per_hour_usd,
        });
      }
      out.transcriptions = {
        defaultFamily: defaultFamily?.value,
        families: Array.from(byFamily.values()),
      };
    }

    if (sections.settings) {
      const s: ConfigSettings = {};
      const strat = db.prepare(
        "SELECT value FROM settings WHERE key = 'routing_strategy'",
      ).get() as { value: string } | undefined;
      const retry = db.prepare(
        "SELECT value FROM settings WHERE key = 'global_retry_limit'",
      ).get() as { value: string } | undefined;
      const weights = db.prepare(
        "SELECT value FROM settings WHERE key = 'routing_custom_weights'",
      ).get() as { value: string } | undefined;
      // L30: inventory-counted settings keys — emitted so the inventory
      // count and the emitted fields stay aligned.
      const fam = db.prepare(
        "SELECT value FROM settings WHERE key = 'embeddings_default_family'",
      ).get() as { value: string } | undefined;
      const tfam = db.prepare(
        "SELECT value FROM settings WHERE key = 'transcriptions_default_family'",
      ).get() as { value: string } | undefined;
      if (strat) s.routingStrategy = strat.value as ConfigSettings['routingStrategy'];
      if (retry) s.globalRetryLimit = parseInt(retry.value, 10);
      if (fam) s.embeddingsDefaultFamily = fam.value;
      if (tfam) s.transcriptionsDefaultFamily = tfam.value;
      if (weights) {
        try {
          s.customWeights = JSON.parse(weights.value);
        } catch { /* ignore — the importer falls back to defaults */ }
      }
      if (Object.keys(s).length > 0) {
        out.settings = s;
      }
    }

    if (sections.quirks) {
      const qRows = db.prepare(`
        SELECT id, slug, title, body, severity FROM quirks ORDER BY id ASC
      `).all() as Array<{
        id: number; slug: string; title: string; body: string; severity: string;
      }>;
      const tRows = db.prepare(`SELECT quirk_id, platform, model_glob FROM quirk_targets`).all() as Array<{
        quirk_id: number; platform: string | null; model_glob: string | null;
      }>;
      const targetsByQ = new Map<number, ConfigQuirk['targets']>();
      for (const t of tRows) {
        let arr = targetsByQ.get(t.quirk_id);
        if (!arr) { arr = []; targetsByQ.set(t.quirk_id, arr); }
        arr.push({ platform: t.platform, modelGlob: t.model_glob });
      }
      out.quirks = qRows.map<ConfigQuirk>((r) => ({
        slug: r.slug,
        title: r.title,
        body: r.body,
        severity: (r.severity === 'critical' || r.severity === 'warning'
          ? r.severity : 'info') as ConfigQuirk['severity'],
        targets: targetsByQ.get(r.id) ?? [],
      }));
    }
  });
  tx();
  return out;
}

/**
 * Build a full export envelope. Key-transport policy: without a
 * `passphrase`, every decryptable API key is embedded in cleartext in
 * `sections.apiKeys` by design — the backup restores on any host with no
 * ENCRYPTION_KEY dependency; rows whose ciphertext failed to decrypt at
 * export time keep only their encryptedKey/iv/authTag fields. With a
 * `passphrase`, that plaintext moves into a self-describing `keysCipher`
 * blob and row-level key fields are stripped — so even a malicious actor
 * with the file but not the passphrase cannot recover the keys.
 */
export function buildExport(opts: BuildExportOptions = {}): ConfigEnvelope {
  const requested = sectionSet(opts.sections);
  const db = getDb();
  const sections = readSection(db, requested);
  let keysCipher: ConfigEnvelope['keysCipher'];

  if (opts.passphrase) {
    if (!sections.apiKeys) {
      throw new ConfigExportError(
        'api_keys section not in export — nothing to encrypt',
      );
    }
    // Include the row's label so multiple keys per platform survive the
    // passphrase round-trip — keying by platform alone collapsed every key
    // of a platform into the last one on import (C14).
    const plaintext = sections.apiKeys
      .filter((k) => typeof k.key === 'string' && k.key.length > 0)
      .map((k) => ({ platform: k.platform, label: k.label, key: k.key as string }));
    if (plaintext.length === 0) {
      throw new ConfigExportError(
        'no decryptable API keys to encrypt — every key failed to decrypt',
      );
    }
    keysCipher = encryptKeysWithPassphrase(plaintext, opts.passphrase);
    sections.apiKeys = sections.apiKeys.map((k) => {
      const { key: _omit, ...rest } = k;
      return rest;
    });
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    generator: CONFIG_GENERATOR,
    exportedAt: new Date().toISOString(),
    label: opts.label,
    sections,
    keysCipher,
  };
}

/**
 * Returns a brief inventory of what's exportable — used by the Settings UI
 * before the user clicks "Export" so they can see how big the file will be.
 */
export function getExportInventory(): Record<ConfigSection, number> {
  const db = getDb();
  return {
    models: (db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n,
    fallback_chain: (db.prepare('SELECT COUNT(*) AS n FROM fallback_config').get() as { n: number }).n,
    custom_providers: (db.prepare('SELECT COUNT(*) AS n FROM custom_providers').get() as { n: number }).n,
    api_keys: (db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n,
    client_keys: (db.prepare('SELECT COUNT(*) AS n FROM client_keys').get() as { n: number }).n,
    budgets: (db.prepare('SELECT COUNT(*) AS n FROM budgets').get() as { n: number }).n,
    webhooks: (db.prepare('SELECT COUNT(*) AS n FROM webhooks').get() as { n: number }).n,
    embeddings: (db.prepare('SELECT COUNT(*) AS n FROM embedding_models').get() as { n: number }).n,
    transcriptions: (db.prepare('SELECT COUNT(*) AS n FROM transcription_models').get() as { n: number }).n,
    settings: (db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('routing_strategy','global_retry_limit','routing_custom_weights','embeddings_default_family','transcriptions_default_family')").get() as { n: number }).n,
    quirks: (db.prepare('SELECT COUNT(*) AS n FROM quirks').get() as { n: number }).n,
  };
}

export type { ConfigExportRequest };
