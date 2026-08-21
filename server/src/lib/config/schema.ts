// Config envelope Zod validators. These mirror the types in shared/types.ts
// but enforce runtime shape on import — the shared types are erased at
// runtime, and importing an attacker-controlled JSON file (it's behind
// requireAuth, but a malicious admin session still warrants validation)
// demands real validation, not duck typing.
//
// Schemas are deliberately strict in places the wire types are loose
// (e.g. embedded model_id patterns) — a malformed envelope should fail
// loud and clear rather than be silently coerced into something the
// destination can't safely store.
import { z } from 'zod';

// ── Primitives ───────────────────────────────────────────────────────────

const platform = z.string().min(1).max(64);
// A model_id is opaque to us but we cap it so a malformed envelope can't
// dump megabyte strings into SQLite. 256 covers any reasonable provider.
const modelId = z.string().min(1).max(256);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, {
  message: 'slug must be lowercase letters, digits and dashes (2-32 chars, no leading/trailing dash)',
});
const url = z.string().url().max(2048);
// AES-GCM envelope fields are fixed-width lowercase hex, sized by
// passphrase-crypto.ts: salt = 16 bytes → 32 chars, IV = 12 bytes → 24,
// auth tag = 16 bytes → 32.
const hexSalt = z.string().regex(/^[0-9a-f]{32}$/, { message: 'must be 32 lowercase hex chars (16-byte salt)' });
const hexIv = z.string().regex(/^[0-9a-f]{24}$/, { message: 'must be 24 lowercase hex chars (12-byte IV)' });
const hexTag = z.string().regex(/^[0-9a-f]{32}$/, { message: 'must be 32 lowercase hex chars (16-byte auth tag)' });

// ── Per-section schemas ───────────────────────────────────────────────────

const modelSchema = z.object({
  platform,
  modelId,
  displayName: z.string().min(1).max(200),
  intelligenceRank: z.number().int().min(0).max(100),
  speedRank: z.number().int().min(0).max(100),
  sizeLabel: z.string().max(32).default(''),
  rpmLimit: z.number().int().nullable(),
  rpdLimit: z.number().int().nullable(),
  tpmLimit: z.number().int().nullable(),
  tpdLimit: z.number().int().nullable(),
  monthlyTokenBudget: z.string().max(64).default(''),
  contextWindow: z.number().int().nullable(),
  enabled: z.boolean(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  maxOutputTokens: z.number().int().nullable(),
  paidInputPerM: z.number().nullable(),
  paidOutputPerM: z.number().nullable(),
  overwriteBuiltin: z.boolean().optional(),
});

const fallbackEntrySchema = z.object({
  platform,
  modelId,
  // Optional for backward compatibility with envelopes exported by
  // earlier versions: when absent, the importer falls back to using
  // the entry's list position (1-based) as the priority. New exports
  // always include it, which makes a no-op round-trip byte-exact
  // even when the chain has duplicate priorities or gaps.
  priority: z.number().int().min(0).optional(),
  enabled: z.boolean(),
});

const customProviderSchema = z.object({
  slug,
  displayName: z.string().min(1).max(100),
  baseUrl: url,
  rpmLimit: z.number().int().nullable(),
  rpdLimit: z.number().int().nullable(),
  tpmLimit: z.number().int().nullable(),
  tpdLimit: z.number().int().nullable(),
  maxParallelRequests: z.number().int().nullable(),
  archived: z.boolean(),
  keyless: z.boolean(),
  apiFormat: z.enum(['openai', 'anthropic']),
});

const apiKeySchema = z.object({
  platform,
  label: z.string().max(120).default(''),
  enabled: z.boolean(),
  // Exactly one of (key) or (encryptedKey + iv + authTag) is required.
  // Zod can't express XOR cleanly here; the importer runs a check after.
  key: z.string().max(2048).optional(),
  encryptedKey: z.string().max(8192).optional(),
  iv: z.string().max(64).optional(),
  authTag: z.string().max(64).optional(),
  baseUrl: url.nullable().optional(),
}).refine(
  (v) => Boolean(v.key) || Boolean(v.encryptedKey && v.iv && v.authTag),
  { message: 'api_keys entry needs either `key` or `encryptedKey + iv + authTag`' },
);

const embeddingProviderSchema = z.object({
  platform,
  modelId,
  priority: z.number().int().min(0),
  enabled: z.boolean(),
});

const embeddingFamilySchema = z.object({
  family: z.string().min(1).max(100),
  providers: z.array(embeddingProviderSchema).max(64),
  dimensions: z.number().int().positive(),
  maxInputTokens: z.number().int().nullable(),
  displayName: z.string().min(1).max(200),
  quotaLabel: z.string().max(200).default(''),
});

const embeddingsSectionSchema = z.object({
  defaultFamily: z.string().min(1).max(100).optional(),
  families: z.array(embeddingFamilySchema).max(64),
});

const settingsSchema = z.object({
  routingStrategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']).optional(),
  globalRetryLimit: z.number().int().min(0).max(100).optional(),
  customWeights: z.object({
    reliability: z.number().min(0).max(1),
    speed: z.number().min(0).max(1),
    intelligence: z.number().min(0).max(1),
  }).optional(),
  // L30: the export inventory counts embeddings_default_family among the
  // settings keys — the section must carry it for round-trip parity.
  embeddingsDefaultFamily: z.string().min(1).max(100).optional(),
}).refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: 'settings section cannot be empty' },
);

const quirkTargetSchema = z.object({
  platform: z.string().nullable(),
  modelGlob: z.string().nullable(),
});

const quirkSchema = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, {
    // Lowercase only — quirk slugs are generated lowercase and matched
    // case-sensitively against the dashboard's quirk list.
    message: 'quirk slug must be lowercase alphanumeric (dashes allowed)',
  }),
  title: z.string().min(1).max(200),
  body: z.string().max(8192).default(''),
  severity: z.enum(['info', 'warning', 'critical']),
  targets: z.array(quirkTargetSchema).max(64),
});

const keysCipherSchema = z.object({
  // Versioned KDF ids — new exports use 600k iterations; legacy 310k
  // envelopes must stay importable (the loader switches on this string).
  kdf: z.union([z.literal('pbkdf2-sha256-600000'), z.literal('pbkdf2-sha256-310000')]),
  salt: hexSalt,
  iv: hexIv,
  authTag: hexTag,
  ciphertext: z.string().min(1).max(131072), // 64 KB ciphertext cap
});

// ── Envelope ──────────────────────────────────────────────────────────────



export const configEnvelopeSchema = z.object({
  schemaVersion: z.number().int().min(1).max(1000),
  generator: z.string().min(1).max(64),
  // M43: the old `.or(z.string().min(1).max(64))` accepted ANY non-empty
  // string, voiding datetime validation entirely. Strict ISO-8601 only;
  // importers of pre-normalization envelopes must fix exportedAt upstream.
  exportedAt: z.string().datetime({ offset: true }),
  label: z.string().max(120).optional(),
  sections: z.object({
    models: z.array(modelSchema).max(2000).optional(),
    fallbackChain: z.array(fallbackEntrySchema).max(2000).optional(),
    customProviders: z.array(customProviderSchema).max(64).optional(),
    apiKeys: z.array(apiKeySchema).max(256).optional(),
    embeddings: embeddingsSectionSchema.optional(),
    settings: settingsSchema.optional(),
    quirks: z.array(quirkSchema).max(256).optional(),
  }).refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: 'envelope must contain at least one section' },
  ),
  keysCipher: keysCipherSchema.optional(),
});

// ── Import options ────────────────────────────────────────────────────────

export const configImportOptionsSchema = z.object({
  mode: z.enum(['skip-existing', 'overwrite', 'replace']).default('skip-existing'),
  dryRun: z.boolean().default(false),
  passphrase: z.string().min(1).max(1024).optional(),
  sections: z.array(z.enum([
    'models', 'fallback_chain', 'custom_providers', 'api_keys', 'embeddings', 'settings', 'quirks',
  ])).min(1).max(16).optional(),
});

export type ParsedEnvelope = z.infer<typeof configEnvelopeSchema>;
export type ParsedImportOptions = z.infer<typeof configImportOptionsSchema>;
