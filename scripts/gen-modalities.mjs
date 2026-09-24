#!/usr/bin/env node
/**
 * Generate `server/src/db/modality-index.ts` from public model catalogs.
 *
 * Why this exists: the gateway needs to know, per (platform, model_id), which
 * input modalities a model accepts. Guessing from id patterns (the old
 * `applyVisionRules`) is both over- and under-inclusive. Two catalogs publish
 * real per-model modality data:
 *
 *   - models.dev  https://models.dev/api.json         (provider-keyed)
 *   - OpenRouter  https://openrouter.ai/api/v1/models (vendor/model-keyed)
 *
 * Neither uses the gateway's platform slugs, so matching happens in two tiers:
 *
 *   1. Provider-scoped: the gateway platform aliases to a catalog provider id
 *      and the normalized model ids match. Highest confidence — the catalog
 *      says this specific provider exposes these modalities for this model.
 *   2. Cross-provider: the normalized model id matches any provider's entry.
 *      This is how the aggregators (unorouter, tokenharbor, …) get data at
 *      all: they resell models the catalogs index under their origin vendor.
 *
 * A row is emitted for EVERY model found in a catalog, including text-only
 * ones (explicit `false`s). That matters: it makes the index authoritative for
 * matched rows, so a stale heuristic flag from `applyVisionRules` cannot
 * survive on a model the catalogs say is text-only. Only rows absent from the
 * index keep their existing flags.
 *
 * Usage:
 *   node scripts/gen-modalities.mjs                            # fetch catalogs
 *   node scripts/gen-modalities.mjs --cache DIR                # reuse downloads
 *   node scripts/gen-modalities.mjs --cache DIR --save-cache   # keep downloads
 *
 * Exit codes: 0 ok, 1 coverage below floor, 2 fetch/parse failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'server', 'data', 'api-gateway.db');
const OUT_TS = path.join(REPO_ROOT, 'server', 'src', 'db', 'modality-index.ts');

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const MIN_COVERAGE = 0.8;

/** Trailing variant suffixes that do not change the underlying model. */
const VARIANT_SUFFIXES = [
  'free', 'nitro', 'extended', 'beta', 'latest', 'thinking', 'preview',
  'online', 'self-moderated', 'floor', 'exacto', 'high', 'low', 'medium',
];

/**
 * Canonical form for cross-catalog model comparison: lowercase, drop trailing
 * variant suffixes, drop every non-alphanumeric character. `gpt-4o` and
 * `gpt4o` both normalize to `gpt4o`.
 */
function normalizeModelId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let s = raw.toLowerCase().trim();
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const suffix of VARIANT_SUFFIXES) {
      for (const sep of [':', '-', '_']) {
        const token = `${sep}${suffix}`;
        if (s.endsWith(token) && s.length > token.length + 2) {
          s = s.slice(0, -token.length);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return s.replace(/[^a-z0-9]/g, '');
}

/** Last path segment of a vendor-qualified id, or the id itself. */
function lastSegment(id) {
  if (typeof id !== 'string') return '';
  const idx = id.lastIndexOf('/');
  return idx === -1 ? id : id.slice(idx + 1);
}

/**
 * Generic routing aliases. Catalogs describe these as "everything the router
 * can reach", so their modality union is meaningless for any single model.
 * Indexing them under their bare last segment (`openrouter/auto` -> `auto`)
 * would leak a full multimodal flag set onto every unrelated row literally
 * named `auto`. They keep their vendor-qualified key and contribute nothing to
 * the cross-provider tier.
 */
const GENERIC_ALIASES = new Set([
  'auto', 'default', 'router', 'chat', 'random', 'best', 'dynamic', 'any',
]);

/**
 * Gateway platform slug -> catalog provider ids. Only non-obvious renames live
 * here; a slug absent from this map is tried verbatim in both catalogs. A
 * `null` catalog id means that catalog has no provider for this platform
 * (OpenRouter qualifies every model by its origin vendor, so its own platform
 * slug is not a vendor name).
 */
const PLATFORM_TO_CATALOG = {
  google: { modelsdev: 'google', openrouter: 'google' },
  openai: { modelsdev: 'openai', openrouter: 'openai' },
  anthropic: { modelsdev: 'anthropic', openrouter: 'anthropic' },
  groq: { modelsdev: 'groq', openrouter: 'groq' },
  mistral: { modelsdev: 'mistral', openrouter: 'mistralai' },
  cohere: { modelsdev: 'cohere', openrouter: 'cohere' },
  cerebras: { modelsdev: 'cerebras', openrouter: 'cerebras' },
  nvidia: { modelsdev: 'nvidia', openrouter: 'nvidia' },
  openrouter: { modelsdev: 'openrouter', openrouter: null },
  cloudflare: { modelsdev: 'cloudflare', openrouter: 'cloudflare' },
  zhipu: { modelsdev: 'zhipuai', openrouter: 'z-ai' },
  github: { modelsdev: 'github', openrouter: 'github' },
  ovh: { modelsdev: 'ovh', openrouter: 'ovhcloud' },
  deepseek: { modelsdev: 'deepseek', openrouter: 'deepseek' },
  xai: { modelsdev: 'xai', openrouter: 'xai' },
  ollama: { modelsdev: 'ollama', openrouter: 'ollama' },
  huggingface: { modelsdev: 'huggingface', openrouter: 'huggingface' },
};

/** Catalog modality list -> our three flags. `pdf`/`file` are out of scope. */
function flagsFromInputList(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return { image: set.has('image'), audio: set.has('audio'), video: set.has('video') };
}

function mergeFlags(a, b) {
  return {
    image: Boolean(a?.image || b?.image),
    audio: Boolean(a?.audio || b?.audio),
    video: Boolean(a?.video || b?.video),
  };
}

function parseArgs(argv) {
  const out = { cache: null, saveCache: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cache') out.cache = argv[i + 1];
    else if (argv[i] === '--save-cache') out.saveCache = true;
  }
  return out;
}

async function loadSource(url, cachePath, saveCache) {
  if (cachePath && fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, 'utf8');
    if (raw.trim().length > 0) return JSON.parse(raw);
  }
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'api-gateway-modality-index' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const text = await res.text();
  if (saveCache && cachePath) fs.writeFileSync(cachePath, text);
  return JSON.parse(text);
}

/**
 * Build the lookups.
 *   scoped[providerId] -> Map(normalizedModelId -> flags)
 *   global             -> Map(normalizedModelId -> flags)   (union over providers)
 */
function buildIndexes(modelsDev, openRouter) {
  const scoped = { modelsdev: new Map(), openrouter: new Map() };
  const global = new Map();

  const put = (map, key, flags) => {
    if (!key) return;
    map.set(key, mergeFlags(map.get(key), flags));
  };

  const addScoped = (tier, providerId, modelId, flags) => {
    if (!providerId || !modelId) return;
    const key = normalizeModelId(modelId);
    if (!key) return;
    const bucket = scoped[tier];
    if (!bucket.has(providerId)) bucket.set(providerId, new Map());
    put(bucket.get(providerId), key, flags);
  };

  /**
   * Global (cross-provider) contribution. A vendor-qualified id whose last
   * segment normalizes to a generic routing alias contributes only under its
   * full id — its union of modalities says nothing about a specific model.
   * The comparison must use the NORMALIZED key: `openrouter/auto-beta` has the
   * raw tail `auto-beta`, which normalizes (variant suffix dropped) to exactly
   * the `auto` key it would otherwise poison.
   */
  const addGlobal = (modelId, flags) => {
    const tailKey = normalizeModelId(lastSegment(modelId));
    if (tailKey && !GENERIC_ALIASES.has(tailKey)) put(global, tailKey, flags);
    if (typeof modelId === 'string' && modelId.includes('/')) {
      put(global, normalizeModelId(modelId), flags);
    }
  };

  for (const [providerId, provider] of Object.entries(modelsDev ?? {})) {
    for (const model of Object.values(provider?.models ?? {})) {
      const flags = flagsFromInputList(model?.modalities?.input);
      const ids = new Set([model?.id, lastSegment(model?.id)]);
      for (const id of ids) addScoped('modelsdev', providerId, id, flags);
      addGlobal(model?.id, flags);
    }
  }

  for (const model of openRouter?.data ?? []) {
    const flags = flagsFromInputList(model?.architecture?.input_modalities);
    const vendor = typeof model?.id === 'string' ? model.id.split('/')[0] : null;
    const ids = new Set([model?.id, lastSegment(model?.id)]);
    for (const id of ids) addScoped('openrouter', vendor, id, flags);
    addGlobal(model?.id, flags);
  }

  return { scoped, global };
}

function lookupScoped(tier, providerId, modelId) {
  if (!providerId || !modelId) return null;
  const byModel = tier.get(providerId);
  if (!byModel) return null;
  return byModel.get(normalizeModelId(lastSegment(modelId))) ?? null;
}

function readGatewayRows() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`gateway DB not found at ${DB_PATH} — run the server once first`);
  }
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT platform, model_id FROM models ORDER BY platform, model_id').all();
  } finally {
    db.close();
  }
}

async function run(args) {
  const cacheDir = args.cache ? path.resolve(args.cache) : null;
  const mdPath = cacheDir ? path.join(cacheDir, 'models-dev.json') : null;
  const orPath = cacheDir ? path.join(cacheDir, 'openrouter-models.json') : null;

  let modelsDev;
  let openRouter;
  try {
    [modelsDev, openRouter] = await Promise.all([
      loadSource(MODELS_DEV_URL, mdPath, args.saveCache),
      loadSource(OPENROUTER_URL, orPath, args.saveCache),
    ]);
  } catch (err) {
    console.error(`[gen-modalities] fetch failed: ${err.message}`);
    process.exit(2);
  }

  const { scoped, global } = buildIndexes(modelsDev, openRouter);
  const rows = readGatewayRows();

  const entries = [];
  const stats = { total: rows.length, found: 0, scopedMd: 0, scopedOr: 0, cross: 0, miss: 0 };
  const raised = { image: 0, audio: 0, video: 0 };
  const perPlatform = new Map();
  const misses = [];

  for (const { platform, model_id: modelId } of rows) {
    const alias = PLATFORM_TO_CATALOG[platform] ?? { modelsdev: platform, openrouter: platform };
    const mdHit = lookupScoped(scoped.modelsdev, alias.modelsdev, modelId);
    const orHit = lookupScoped(scoped.openrouter, alias.openrouter, modelId);

    let flags = null;
    if (mdHit || orHit) {
      flags = mergeFlags(mdHit, orHit);
      stats.scopedMd += mdHit ? 1 : 0;
      stats.scopedOr += !mdHit && orHit ? 1 : 0;
    } else {
      const globalHit = global.get(normalizeModelId(lastSegment(modelId)));
      if (globalHit) {
        flags = globalHit;
        stats.cross += 1;
      }
    }

    const bucket = perPlatform.get(platform) ?? { total: 0, found: 0 };
    bucket.total += 1;

    if (flags) {
      entries.push({ platform, modelId, flags });
      bucket.found += 1;
      stats.found += 1;
      if (flags.image) raised.image += 1;
      if (flags.audio) raised.audio += 1;
      if (flags.video) raised.video += 1;
    } else {
      stats.miss += 1;
      if (misses.length < 20) misses.push(`${platform}/${modelId}`);
    }
    perPlatform.set(platform, bucket);
  }

  const coverage = stats.total === 0 ? 0 : stats.found / stats.total;

  entries.sort((a, b) => {
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
  });

  const lines = [
    '// GENERATED FILE — do not edit by hand.',
    '//',
    '// Source: https://models.dev/api.json + https://openrouter.ai/api/v1/models,',
    '// joined against the gateway model catalog. Regenerate with',
    '//   node scripts/gen-modalities.mjs --cache /tmp --save-cache',
    '//',
    '// A key present here is AUTHORITATIVE for that row: the applier writes all',
    '// three flags, including explicit false for a modality the catalogs say the',
    '// model does not take. Rows absent from this index keep whatever flags they',
    '// already have (heuristic seed or operator edit).',
    '',
    'export interface ModalityFlags {',
    '  /** Present and true only when a catalog declares that modality. */',
    '  image?: boolean;',
    '  audio?: boolean;',
    '  video?: boolean;',
    '}',
    '',
    '/** Join key used by MODALITY_INDEX — keep in sync with the applier. */',
    'export function modalityIndexKey(platform: string, modelId: string): string {',
    '  return `${platform}\\u0000${modelId}`;',
    '}',
    '',
    `/** ${entries.length} of ${stats.total} catalog rows resolved to a source entry. */`,
    'export const MODALITY_INDEX: ReadonlyMap<string, ModalityFlags> = new Map([',
  ];
  for (const { platform, modelId, flags } of entries) {
    const parts = [];
    if (flags.image) parts.push('image: true');
    if (flags.audio) parts.push('audio: true');
    if (flags.video) parts.push('video: true');
    lines.push(
      `  [modalityIndexKey(${JSON.stringify(platform)}, ${JSON.stringify(modelId)}), { ${parts.join(', ')} }],`,
    );
  }
  lines.push(']);', '');

  fs.writeFileSync(OUT_TS, lines.join('\n'));

  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) : '0');
  console.log(`[gen-modalities] resolved ${stats.found}/${stats.total} rows (${(coverage * 100).toFixed(1)}%)`);
  console.log(`  tier: models.dev-scoped=${stats.scopedMd} openrouter-scoped=${stats.scopedOr} cross-provider=${stats.cross} unmatched=${stats.miss}`);
  console.log(`  flags true: image=${raised.image} audio=${raised.audio} video=${raised.video}`);
  console.log(`  wrote ${path.relative(REPO_ROOT, OUT_TS)} (${(fs.statSync(OUT_TS).size / 1024).toFixed(0)} KB)`);
  const sorted = [...perPlatform.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log('  per platform (resolved/total):');
  for (const [p, b] of sorted) {
    console.log(`    ${p.padEnd(20)} ${String(b.found).padStart(5)}/${String(b.total).padEnd(5)} ${pct(b.found, b.total).padStart(3)}%`);
  }
  if (misses.length) console.log(`  unmatched sample: ${misses.slice(0, 6).join(', ')} …`);

  if (coverage < MIN_COVERAGE) {
    console.error(
      `[gen-modalities] coverage ${(coverage * 100).toFixed(1)}% below the ${(MIN_COVERAGE * 100).toFixed(0)}% floor`,
    );
    process.exit(1);
  }
}

run(parseArgs(process.argv.slice(2)));
