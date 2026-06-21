// ---- Platform & Model Types ----

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
// Moonshot and MiniMax direct integrations were dropped in migrateModelsV4
// (see server/src/db/index.ts). HuggingFace was dropped in V4 and re-added
// in V13 via the router.huggingface.co Inference Providers meta-router.
// SambaNova was dropped in V23 (free tier permanently retired — 402
// "payment method required" once the one-time $5 trial credit lapses).
export type Platform =
  | 'google'
  | 'groq'
  | 'cerebras'
  | 'nvidia'
  | 'mistral'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'zhipu'
  | 'ollama'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'huggingface'
  // OpenCode Zen — OpenAI-compatible gateway. Free promotional models require a
  // free (no-card) account key from opencode.ai/auth; see migrateModelsV18.
  | 'opencode'
  // OVHcloud AI Endpoints — OpenAI-compatible, keyless anonymous tier
  // (2 req/min per IP per model); see migrateModelsV26.
  | 'ovh'
  | 'commandcode';
// NOTE: the literal string 'custom' is no longer a special platform. Users add
// their own OpenAI-compatible providers (ollama, llama.cpp, LM Studio, vLLM,
// any base_url) via POST /api/custom-providers, and the resulting slug becomes
// the value in models.platform / api_keys.platform. The router, analytics, and
// health checks key off the platform string and treat it identically to a
// built-in — the only difference is the base URL lives in custom_providers.

export interface CustomProvider {
  id: number;
  slug: string;
  displayName: string;
  baseUrl: string;
  createdAt: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  maxParallelRequests: number | null;
  keyless: boolean;
  apiFormat: 'openai' | 'anthropic';
  archived: boolean;
}
export interface CustomProviderCreate {
  slug: string;
  displayName: string;
  baseUrl: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  maxParallelRequests?: number | null;
  keyless?: boolean;
  apiFormat?: 'openai' | 'anthropic';
}

export interface CustomProviderUpdate {
  displayName?: string;
  baseUrl?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  maxParallelRequests?: number | null;
  keyless?: boolean;
  apiFormat?: 'openai' | 'anthropic';
}

export interface CustomModelCreate {
  providerSlug: string;
  modelId: string;
  displayName: string;
  contextWindow?: number | null;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  monthlyTokenBudget?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
}

export interface CustomModelUpdate {
  displayName?: string;
  contextWindow?: number | null;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  monthlyTokenBudget?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  enabled?: boolean;
}

export interface Model {
  id: number;
  // Built-in platforms (Platform union) plus user-defined slugs from
  // custom_providers. The DB stores arbitrary strings; only the add-key form
  // narrows to the built-in union.
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
}

export interface ModelListRow {
  // id is the row PK — not currently surfaced on /v1/models but useful
  // for callers that want to deep-link to the admin edit page.
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  // Catalogued caps surfaced through /v1/models so clients can route
  // requests to a model whose capabilities match the request shape
  // (vision/tools/output budget) without probing blindly. Added for the
  // OpenAI-completions-compatible capabilities payload.
  max_output_tokens: number | null;
  supports_vision: number;
  supports_tools: number;
  intelligence_rank: number;
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKey {
  id: number;
  platform: string;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
}

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: {
      name: string;
    };
  };

// OpenAI's multimodal envelope: clients like opencode / continue.dev send
// content as an array of typed blocks even for text-only messages, and
// Gemini-lineage agents (Qwen Code, AionUI) send part-style `{ text }` blocks
// with no `type` — plus bare strings inside arrays. We accept all of it on
// the wire and flatten to string for providers that don't support arrays
// (Cohere, Cloudflare). See server/src/lib/content.ts. (#200)
export type ChatContentBlock = string | { type?: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  // The model's thinking trace on an assistant turn. Some thinking models
  // (DeepSeek on OpenCode Zen) require it to be replayed verbatim on the next
  // turn or they 400; the proxy preserves and forwards it. See issue #255.
  reasoning_content?: string | null;
  // Anthropic-specific extended-thinking signature (encrypted reasoning).
  // Required to be replayed alongside `reasoning_content` so multi-turn tool
  // loops don't reject the request. Provider-specific; other providers ignore.
  thinking_signature?: string | null;
}

// Unified thinking-effort hint. Linear scale; providers map to their native
// vocabulary (`thinking.level`, `thinkingBudget`, `output_config.effort`, etc.).
// `xhigh` is Anthropic-only; providers that don't recognize it collapse it to
// `high` so the user's intent is honored.
export type ThinkingEffort = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal';

// Reasoning trace replay hint. `enabled` carries Anthropic's `budget_tokens`
// (and can coexist with `effort` for the newer Opus 4.6 / Sonnet 4.6 adaptive
// mode). `adaptive` is Anthropic's newer mood; `disabled` is honored where the
// model supports it. Providers that don't understand a given variant drop it.
export interface ThinkingConfig {
  // Anthropic-style: 'enabled' | 'adaptive' | 'disabled'.
  // OpenAI-compat / Google: 'enabled' | 'disabled'.
  type?: 'enabled' | 'adaptive' | 'disabled';
  effort?: ThinkingEffort;
  // Anthropic budget_tokens; Google Gemini 2.5 thinkingBudget. Optional.
  budget?: number;
  // Anthropic display hint ('summarized' | 'omitted'). Optional.
  display?: 'summarized' | 'omitted';
  // Google, also returned by some OpenAI-compat providers: include the raw
  // (non-summarized) reasoning trace in the response. Default true when
  // thinking is enabled.
  includeThoughts?: boolean;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  // OpenAI-compat "reasoning_effort" field. Equivalent to
  // thinking.effort but separate for clients that already use it. Providers
  // normalize into their native thinking config. (#290)
  reasoning_effort?: ThinkingEffort;
  // Richer thinking-control object. Forwarded per-provider with shape
  // adaptation (`thinking` for Anthropic, `thinkingConfig` for Google,
  // `reasoning_effort`/`reasoning` for OpenAI-compat). (#290)
  thinking?: ThinkingConfig;
}
export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: ChatToolCall[];
      // Streaming reasoning trace delta. Anthropic's `thinking_delta` and
      // Gemini's `thought:true` parts arrive as incremental strings here.
      // (#290)
      reasoning_content?: string;
      // Anthropic thought signature — emitted once per turn, on the chunk
      // that closes the thinking block. Clients persist it for replay. (#290)
      thinking_signature?: string;
    };
    finish_reason: string | null;
  }[];
  usage?: TokenUsage;
}

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  estimatedCostSavings: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- Rate Limit Types ----

// ──── Configuration Export / Import ─────────────────────────────────────────

// Versioned, portable snapshot of the user's gateway configuration. Each
// section is independent: an export may carry any subset, and the import
// service processes only what's present. New fields are additive; old fields
// are preserved on round-trip but ignored on import if unknown (forward
// compatibility). The `schemaVersion` is bumped for non-additive changes.
export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_GENERATOR = 'api-gateway';

export type ConfigSection =
  | 'models'
  | 'fallback_chain'
  | 'custom_providers'
  | 'api_keys'
  | 'embeddings'
  | 'settings'
  | 'quirks';

// Imported record types — every field uses camelCase and matches the wire
// shape returned by the relevant /api/* endpoints, except `id`/`keyId` (which
// are remapped server-side because source IDs don't carry over).

export interface ConfigModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  maxOutputTokens: number | null;
  paidInputPerM: number | null;
  paidOutputPerM: number | null;
  /** When true, import will replace built-in catalog rows for this
   * (platform, model_id) with the exported values. Built-in models are
   * normally read-only on import; opt in explicitly so users can carry
   * rank tweaks between instances. */
  overwriteBuiltin?: boolean;
}

export interface ConfigFallbackEntry {
  /** Natural key: the (platform, modelId) tuple this chain position points
   * at. Resolved against the destination catalog at import time. */
  platform: string;
  modelId: string;
  /** The stored `fallback_config.priority` at export time. Carried in the
   * envelope so a no-op round-trip can detect "row already at this
   * priority" and skip — without needing to infer it from the list
   * position. Duplicates are possible (and preserved): two rows with
   * the same priority stay at the same priority on re-import.
   *
   * Optional for backward compatibility with envelopes produced by
   * earlier versions of the gateway, where the priority was implicit
   * in the list order. New exports always include it. */
  priority?: number;
  enabled: boolean;
}

export interface ConfigCustomProvider {
  slug: string;
  displayName: string;
  baseUrl: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  maxParallelRequests: number | null;
  archived: boolean;
  keyless: boolean;
  apiFormat: 'openai' | 'anthropic';
}

export interface ConfigApiKey {
  platform: string;
  label: string;
  enabled: boolean;
  /** Plaintext key. Required unless the envelope carries a `keysCipher`
   * (passphrase-encrypted blob) AND the user supplies the passphrase at
   * import time — in that case the import server unwraps keys into this
   * field during ingest. */
  key?: string;
  /** When set, the import server treats `key` as already encrypted under
   * the destination's AES key and skips re-encryption. Used when both the
   * source and destination share the same ENCRYPTION_KEY. */
  encryptedKey?: string;
  iv?: string;
  authTag?: string;
  /** Optional base URL for custom providers whose base URL is denormalized
   * onto the key row. */
  baseUrl?: string | null;
}

export interface ConfigEmbeddingFamily {
  family: string;
  /** Ordered list of (platform, modelId, priority, enabled) entries.
   * Position in the array defines the failover order; ties on `priority`
   * fall back to position. */
  providers: Array<{
    platform: string;
    modelId: string;
    priority: number;
    enabled: boolean;
  }>;
  dimensions: number;
  maxInputTokens: number | null;
  displayName: string;
  quotaLabel: string;
}

export interface ConfigSettings {
  routingStrategy?: 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom';
  globalRetryLimit?: number;
  customWeights?: { reliability: number; speed: number; intelligence: number };
}

export interface ConfigQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  targets: Array<{ platform: string | null; modelGlob: string | null }>;
}

export type ConfigMergeMode = 'skip-existing' | 'overwrite' | 'replace';

export interface ConfigImportOptions {
  mode: ConfigMergeMode;
  /** When true, validate and report changes without committing. The
   * response includes a `diff` summary plus any per-section errors. */
  dryRun: boolean;
  /** Optional passphrase for the exported `keysCipher` blob. Required when
   * the envelope includes `keysCipher` and the import mode touches
   * `api_keys`. */
  passphrase?: string;
  /** Per-section overrides. Missing sections are left untouched on the
   * destination. Default: all sections present in the envelope are imported. */
  sections?: ConfigSection[];
}

export interface ConfigEnvelope {
  schemaVersion: number;
  generator: string;
  exportedAt: string;
  /** Optional human-readable label ("Laptop staging" / "Production"). */
  label?: string;
  sections: {
    models?: ConfigModel[];
    fallbackChain?: ConfigFallbackEntry[];
    customProviders?: ConfigCustomProvider[];
    apiKeys?: ConfigApiKey[];
    embeddings?: {
      defaultFamily?: string;
      families: ConfigEmbeddingFamily[];
    };
    settings?: ConfigSettings;
    quirks?: ConfigQuirk[];
  };
  /** Passphrase-encrypted blob holding the plaintext API keys (one JSON
   * array of `{ platform, key }`). When this is set, individual api_keys
   * entries above should NOT include `key` — the import server pulls them
   * from this blob. Always present when the export was created with a
   * passphrase. */
  keysCipher?: {
    kdf: 'pbkdf2-sha256-310000';
    salt: string;
    iv: string;
    authTag: string;
    ciphertext: string;
  };
}

/**
 * Compatibility status between an envelope's api_keys ciphertext and
 * the destination gateway's ENCRYPTION_KEY. Computed cheaply on the
 * preview endpoint (single-row decrypt probe, no DB writes) so the
 * Settings UI can warn the operator before they apply an import.
 *
 * - 'no-keys'                    — envelope has no api_keys section.
 * - 'encrypted-with-passphrase'  — envelope carries a keysCipher blob;
 *                                  the destination will need a
 *                                  passphrase to decrypt it. The
 *                                  row-level ciphertext is irrelevant.
 * - 'plaintext'                  — envelope ships plaintext keys
 *                                  (`sections.apiKeys[*].key` set); no
 *                                  destination-key dependency.
 * - 'compatible'                 — row ciphertext decrypts under the
 *                                  destination's key (same host or
 *                                  matching ENCRYPTION_KEY).
 * - 'mismatch'                   — row ciphertext does NOT decrypt
 *                                  under the destination's key and
 *                                  there is no keysCipher fallback.
 *                                  Restoring these keys requires a
 *                                  re-export with a passphrase.
 */
export type ConfigKeyCompatibility =
  | 'no-keys'
  | 'encrypted-with-passphrase'
  | 'plaintext'
  | 'compatible'
  | 'mismatch';

export interface ConfigImportSummary {
  /** True when dryRun=true and no changes were committed. */
  dryRun: boolean;
  mode: ConfigMergeMode;
  /** ISO timestamp the import finished at. */
  importedAt: string;
  sections: Record<string, {
    added: number;
    updated: number;
    skipped: number;
    removed: number;
    errors: string[];
  }>;
  /** When the import actually mutated data, a record of every created
   * `models.id` and `custom_providers.id` so the client can refresh
   * cached lists without re-fetching everything. */
  ids?: {
    models: Array<{ platform: string; modelId: string; id: number }>;
    customProviders: Array<{ slug: string; id: number }>;
  };
  /** Diagnostic describing whether the envelope's api_keys section is
   * restorable on this gateway. Surfaced on every import response so
   * the UI can explain partial failures without forcing the operator
   * to open the error details panel. Always present on a successful
   * (200) response that touched the api_keys section; absent on
   * envelopes that contain no api_keys at all. */
  keyCompatibility?: {
    /** Coarse classification. See ConfigKeyCompatibility for the
     * semantics of each value. */
    status: ConfigKeyCompatibility;
    /** Total api_keys rows the envelope carries (regardless of
     * compatibility). */
    totalRows: number;
    /** Rows that landed as errors during apply because their
     * ciphertext didn't decrypt under the destination's key. Mirrors
     * the per-row `errors` array on `sections.api_keys` but is folded
     * up here for the UI banner. */
    skippedDueToMismatch: number;
    /** A representative failing row to show in the banner, when any
     * were skipped. Just `platform/label` and the canonical error
     * message — never plaintext. */
    sampleFailure?: { platform: string; label: string; message: string };
  };
}

export interface ConfigExportRequest {
  /** Sections to include. Defaults to every supported section. */
  sections?: ConfigSection[];
  /** Optional passphrase. When supplied, the export bundles a
   * `keysCipher` blob so api_keys entries are stored encrypted and only
   * the holder of the passphrase can decrypt them. Without a passphrase,
   * plaintext api_keys are included directly. */
  passphrase?: string;
  label?: string;
}

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}
