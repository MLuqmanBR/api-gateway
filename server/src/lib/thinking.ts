// Per-provider translation of the unified `thinking` / `reasoning_effort`
// request knobs into the wire shapes each provider actually accepts. The
// proxy layer calls through these helpers so the per-provider code only deals
// with their native vocabulary.
//
// Vocabulary summary:
//
//   Anthropic  ─  top-level `thinking: { type, budget_tokens, display }`
//                 plus `output_config: { effort }` (Opus 4.6+, Sonnet 4.6+).
//                 `type: 'adaptive'` requires `output_config.effort`.
//                 Replay path: assistant turns with extended thinking must
//                 include a thinking block with the original `signature`.
//
//   Google     ─  `generationConfig.thinkingConfig: { thinkingBudget,
//                 thinkingLevel, includeThoughts }`. Gemini 3 series uses
//                 `thinkingLevel`; 2.5 series uses `thinkingBudget`.
//
//   OpenAI-    ─  `reasoning_effort: 'low'|'medium'|'high'|'xhigh'|'max'` as
//   compat       a top-level field on the chat-completions body. Some compat
//                 providers also accept a richer `thinking` object; we pass
//                 both through unchanged when present so model-layer matching
//                 decides.
//
// Anything a provider doesn't recognize is dropped. The proxy never invents
// shape names — it maps every request knob down to a wire field that
// documentation confirms the provider accepts. (#290)

import type { ThinkingConfig, ThinkingEffort } from '@api-gateway/shared/types.js';

// ─── Combined request view ────────────────────────────────────────────────

export interface ThinkingRequest {
  // Effective effort, merging `reasoning_effort` and `thinking.effort`.
  effort?: ThinkingEffort;
  // Whether thinking should be turned on. False means "leave default".
  enabled?: boolean;
  // 'adaptive' is Anthropic-specific. Other providers fall back to enabled.
  adaptive?: boolean;
  // Token budget (Anthropic budget_tokens / Gemini 2.5 thinkingBudget).
  budget?: number;
  // Anthropic display hint.
  display?: 'summarized' | 'omitted';
  // Whether the response should include the raw reasoning trace alongside the
  // summarized text. Anthropic: always true for 'summarized' display. Gemini:
  // true iff `includeThoughts` is unset or true. OpenAI-compat: ignored
  // (the upstream decides).
  includeThoughts?: boolean;
}

/** Combine the two surfaces (`reasoning_effort`, `thinking`) into a single view
 * the per-provider helpers operate on. `reasoning_effort` is just a shorter
 * alias for `thinking.effort`; `thinking.effort` overrides when both are set. */
export function normalizeThinking(opts: {
  reasoning_effort?: ThinkingEffort;
  thinking?: ThinkingConfig;
}): ThinkingRequest | undefined {
  const effort = opts.thinking?.effort ?? opts.reasoning_effort;
  if (!opts.thinking && !opts.reasoning_effort) return undefined;

  const out: ThinkingRequest = {};
  if (effort) out.effort = effort;

  const t = opts.thinking;
  if (t) {
    // mode flags
    if (t.type === 'enabled') {
      out.enabled = true;
    } else if (t.type === 'adaptive') {
      out.adaptive = true;
      out.enabled = true; // adaptive implies on
    } else if (t.type === 'disabled') {
      out.enabled = false;
    } else if (effort) {
      // No explicit type but effort was given: turn thinking on by default so
      // the effort level has something to act on. Providers that don't tie
      // effort to thinking (Anthropic with budget, plain OpenAI-compat) drop
      // the implicit-enable without surprising the caller.
      out.enabled = true;
    }
    if (t.budget !== undefined) out.budget = t.budget;
    if (t.display !== undefined) out.display = t.display;
    if (t.includeThoughts !== undefined) out.includeThoughts = t.includeThoughts;
  } else if (effort) {
    out.enabled = true; // `reasoning_effort` alone is treated as enable.
  }

  return out;
}

// ─── Anthropic ────────────────────────────────────────────────────────────

/** Anthropic-side: emit the wire `thinking` object (and optionally
 * `output_config.effort`). Cards on the table:
 *  - Opus 4.7/4.8 don't accept manual `enabled`; always adaptive.
 *  - Opus 4.6 / Sonnet 4.6 still take enabled but adaptive is recommended.
 *  - effort requires `output_config.effort` on supported models.
 *
 * We don't know which Anthropic model we're talking to at the provider layer —
 * the choice between `enabled` and `adaptive` is left to the caller; the
 * proxy decides based on the model id from the catalog, when available. */
// Anthropic rejects budget_tokens < 1024 in enabled mode (M33) — that is the
// floor the `minimal` effort clamps to below.
const ANTHROPIC_MIN_BUDGET = 1024;

// Effort→thinking-budget ladder in tokens, shared by Anthropic and Gemini 2.5
// (M33 deliberately put both providers on one scale). Only `minimal` is
// provider-specific: Anthropic clamps to its 1024-token enabled-mode floor,
// Gemini 2.5 floors at 0 (the closest supported "off").
const EFFORT_BUDGET_TOKENS = {
  low: 2048,
  medium: 8192,
  high: 16384,
  ceiling: 24576, // xhigh and max clamp here
} as const;

const ANTHROPIC_EFFORT_BUDGET: Record<ThinkingEffort, number> = {
  minimal: ANTHROPIC_MIN_BUDGET,
  low: EFFORT_BUDGET_TOKENS.low,
  medium: EFFORT_BUDGET_TOKENS.medium,
  high: EFFORT_BUDGET_TOKENS.high,
  xhigh: EFFORT_BUDGET_TOKENS.ceiling,
  max: EFFORT_BUDGET_TOKENS.ceiling,
};

export function anthropicThinking(
  normalized: ThinkingRequest | undefined,
): { thinking?: Record<string, unknown>; output_config?: Record<string, unknown> } {
  if (!normalized) return {};
  const out: { thinking?: Record<string, unknown>; output_config?: Record<string, unknown> } = {};

  if (normalized.enabled === false) {
    return { thinking: { type: 'disabled' } };
  }

  if (normalized.adaptive) {
    out.thinking = { type: 'adaptive' };
  } else if (normalized.enabled === true) {
    const t: Record<string, unknown> = { type: 'enabled' };
    // M33: Anthropic REQUIRES budget_tokens (≥ 1024) alongside
    // type:'enabled' — an effort-only request used to emit a bare
    // {type:'enabled'} and get rejected. Derive the budget from effort;
    // with neither, clamp to the Anthropic floor.
    if (normalized.budget !== undefined) {
      t.budget_tokens = normalized.budget;
    } else if (normalized.effort) {
      t.budget_tokens = ANTHROPIC_EFFORT_BUDGET[normalized.effort];
    } else {
      t.budget_tokens = ANTHROPIC_MIN_BUDGET;
    }
    if (normalized.display) t.display = normalized.display;
    out.thinking = t;
  }
  // effort: valid alongside both adaptive and enabled on supported models.
  if (normalized.effort) {
    out.output_config = { effort: normalized.effort };
  }
  return out;
}

// ─── Google Gemini ────────────────────────────────────────────────────────

// Map an effort level to a Gemini thinkingLevel (string) or thinkingBudget
// (integer). Gemini 3 series reads `thinkingLevel`; 2.5 series reads
// `thinkingBudget`. The `'minimal'` effort only applies to series that
// accept it (Gemini 3); we therefore never index with `minimal` — the
// translation pre-checks the value. (#290)
type GeminiEffort = Exclude<ThinkingEffort, 'minimal'>;
const GEMINI_3_LEVEL: Record<GeminiEffort, string> = {
  max: 'high',
  xhigh: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
};
// Full-effort map: exhaustive over ThinkingEffort so the compiler enforces
// every reachable value (H14 — the previous `Exclude<..., 'minimal'>` map +
// cast silently produced `thinkingBudget: undefined` for effort:'minimal'
// on Gemini 2.5, dropping the user's effort entirely).
const GEMINI_BUDGET: Record<ThinkingEffort, number> = {
  minimal: 0, // 2.5 floor: budget 0 is the closest supported equivalent
  max: EFFORT_BUDGET_TOKENS.ceiling,
  xhigh: EFFORT_BUDGET_TOKENS.ceiling,
  high: EFFORT_BUDGET_TOKENS.high,
  medium: EFFORT_BUDGET_TOKENS.medium,
  low: EFFORT_BUDGET_TOKENS.low,
};
export function geminiThinkingConfig(
  normalized: ThinkingRequest | undefined,
  modelId: string,
): Record<string, unknown> | undefined {
  if (!normalized) return undefined;
  // enabled === false: skip the block entirely; the upstream default is
  // "thinking on" for 2.5 Pro / Flash, but emit-disable is honored by sending
  // thinkingBudget = 0 on series that support it (2.5).
  if (normalized.enabled === false) {
    const isG3 = /gemini[-_]?3/i.test(modelId);
    if (!isG3) return { thinkingBudget: 0 };
    return { thinkingLevel: 'minimal' };
  }
  if (!normalized.enabled) {
    // bail with no block — model picks its own default.
    return undefined;
  }

  const isG3 = /gemini[-_]?3/i.test(modelId);
  const includeThoughts = normalized.includeThoughts ?? true;
  const cfg: Record<string, unknown> = { includeThoughts };

  // Gemini 3 series uses `thinkingLevel` (high/medium/low/minimal); 2.5
  // series uses `thinkingBudget` (an integer). Branch on the resolved effort
  // first — explicit budget always wins, otherwise the chosen series'
  // native envelope carries the effort. #290
  if (isG3) {
    if (normalized.effort === 'minimal') {
      cfg.thinkingLevel = 'minimal';
    } else if (normalized.effort) {
      cfg.thinkingLevel = GEMINI_3_LEVEL[normalized.effort];
    } else if (normalized.budget !== undefined) {
      cfg.thinkingBudget = normalized.budget;
    }
  } else {
    // 2.5 path (also default — older Gemini series fall through here).
    if (normalized.budget !== undefined) {
      cfg.thinkingBudget = normalized.budget;
    } else if (normalized.effort) {
      // Exhaustive Record — 'minimal' maps to the 2.5 floor (budget 0);
      // every other effort has an explicit budget. (H14)
      cfg.thinkingBudget = GEMINI_BUDGET[normalized.effort];
    }
  }
  return cfg;
}

// ─── OpenAI-compat ────────────────────────────────────────────────────────

// Per-host thinking-field policy for OpenAI-compat providers. Each host
// accepts a different subset of the thinking vocabulary, and forwarding a
// field the host rejects produces a 400 — notably GLM-5.1 on some GLM proxies
// returns a pydantic `literal_error` for the rich Anthropic-style `thinking`
// object, killing every request (#292). The gateway therefore never forwards
// a field unless the host is known to accept it.
//
//   'reasoning_effort_only'  default — emit the single `reasoning_effort`
//                            string (derived from `reasoning_effort` OR
//                            `thinking.effort`). Most OpenAI-compat hosts
//                            (NVIDIA, OpenRouter, Groq, Cerebras, …) accept it.
//   'glm_mapped'            GLM hosts — emit ONLY `reasoning_effort`; never
//                            the rich object (GLM rejects it outright,
//                            literal_error). The effort arrives already
//                            redirected to the model's supported level set
//                            (per-model `models.thinking_levels`) and is
//                            forwarded verbatim — no mapping here.
//   'both'                   hosts verified to accept the rich `thinking`
//                            object alongside `reasoning_effort`. Reserved for
//                            explicit allowlisting once a host is confirmed.
export type OpenAiCompatThinkingPolicy =
  | 'reasoning_effort_only'   // default — emit reasoning_effort verbatim
  | 'glm_mapped'              // GLM — forward the (pre-redirected) effort verbatim, drop the rich object
  | 'glm_nvidia'              // GLM on NVIDIA NIM — needs chat_template_kwargs.enable_thinking; accepts full effort range
  | 'glm52_synthetic'         // THINKING_GLM52_SYNTHETIC_HOSTS gateways × glm-5.2 — synthesize thinking={type:'enabled'} so reasoning_content surfaces; forward effort verbatim across the full 7-value enum
  | 'both';                   // forward reasoning_effort + thinking verbatim (verified hosts only)


// GLM-family hosts. GLM's OpenAI-compat wrapper accepts ONLY
// `reasoning_effort` and ONLY the values `none | low | medium | high` — it
// rejects `max`, `xhigh`, `minimal` with a pydantic literal_error, and rejects
// the rich Anthropic-style `thinking` object outright. Which levels a GLM
// model accepts is per-model data (`models.thinking_levels`, seeded for
// glm_mapped rows); the proxy redirects out-of-set requests upstream, so this
// layer forwards the effort verbatim and never the rich object.
// Public GLM wrappers are built in; operators register additional hosts via
// THINKING_GLM_MAPPED_HOSTS (comma-separated platform slugs), read at call
// time so test stubs and runtime restarts both pick up changes. (#292)
function glmMappedHosts(): Set<string> {
  const extra = (process.env.THINKING_GLM_MAPPED_HOSTS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return new Set(['z-ai', 'zai', 'zhipu', ...extra]);
}

/** Hosts registered for the synthetic glm-5.2 thinking switch. */
function syntheticThinkingHosts(): Set<string> {
  return new Set((process.env.THINKING_GLM52_SYNTHETIC_HOSTS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean));
}

/** True when the model id is a GLM-family model (glm-4.x / glm-5.x in any
 *  case, with any org prefix like `z-ai/`, `zai-org/`). Used so GLM models
 *  hosted on non-GLM platforms (e.g. `nvidia/z-ai/glm-5.1`) still get the
 *  GLM effort-mapping treatment regardless of host. */
export function isGlmModel(modelId: string): boolean {
  const m = modelId.toLowerCase();
  // Match `glm-4`, `glm-5`, `glm4`, `glm5` (with or without a separator)
  // after an org prefix like `z-ai/`, `zai-org/`. The 4.x/5.x families are
  // the reasoning GLM models. `glm` must be a token start (preceded by start
  // or `/`) so unrelated ids (e.g. `glmist`) don't trip it.
  return /(^|\/)glm[-_.]?[45]([-_.]|$)/.test(m);
}

/** True for GLM 5.2 served on NVIDIA NIM (`nvidia` + `z-ai/glm-5.2`). This
 *  host+model pair is special: unlike GLM's own OpenAI-compat wrapper (which
 *  the `glm_mapped` policy handles), NVIDIA's GLM 5.2 endpoint ignores a bare
 *  `reasoning_effort` — thinking stays OFF unless the request also carries
 *  `chat_template_kwargs.enable_thinking: true`. It also accepts the FULL
 *  effort range (`minimal`…`max`, all HTTP 200), so its rows keep the
 *  unrestricted default in `models.thinking_levels`. Confirmed live against
 *  `z-ai/glm-5.2` on NVIDIA NIM (all six effort levels return a populated
 *  `reasoning_content`; `reasoning_effort` alone returns none). Scoped to
 *  5.2 — GLM 5.1 on NVIDIA keeps `glm_mapped`. */
export function isGlmNvidiaThinkingModel(platform: string, modelId?: string): boolean {
  if (platform !== 'nvidia' || !modelId) return false;
  // Match `glm-5.2` (any separator / org prefix / case), e.g. `z-ai/glm-5.2`.
  return /(^|\/)glm[-_.]?5[-_.]?2([-_.]|$)/.test(modelId.toLowerCase());
}

/** True for GLM 5.2 served on a synthetic-thinking gateway registered via
 *  THINKING_GLM52_SYNTHETIC_HOSTS (`platform` + `glm-5.2`). Unlike GLM's own
 *  OpenAI-compat wrapper (handled by `glm_mapped`), these gateways accept the
 *  rich `thinking` object AND the full `reasoning_effort` enum
 *  (none|minimal|low|medium|high|xhigh|max). Critically, `reasoning_effort`
 *  alone does NOT surface `reasoning_content` — the `thinking={"type":"enabled"}`
 *  switch is required to make the trace visible, so the body builder synthesizes
 *  it when the caller asks for thinking via `reasoning_effort` alone. Confirmed
 *  live against a registered gateway. Scoped to 5.2; a registered host's other
 *  models (DeepSeek, MiniMax) keep the default. */
export function isSyntheticGlm52ThinkingModel(platform: string, modelId?: string): boolean {
  if (!modelId || !syntheticThinkingHosts().has(platform)) return false;
  // Match `glm-5.2` (any separator / org prefix / case), e.g. `glm-5.2`,
  // `z-ai/glm-5.2`. Same regex shape as isGlmNvidiaThinkingModel.
  return /(^|\/)glm[-_.]?5[-_.]?2([-_.]|$)/.test(modelId.toLowerCase());
}

/** Resolve the thinking-field policy for an OpenAI-compat host. `platform`
 *  is the provider slug; `modelId` is the model being called. A glm-5.2 model
 *  on a gateway registered via THINKING_GLM52_SYNTHETIC_HOSTS gets
 *  `'glm52_synthetic'` (rich `thinking` object + full effort enum, with the
 *  synthesized enable switch) — checked first. GLM 5.2 on NVIDIA NIM gets
 *  `'glm_nvidia'` (needs `chat_template_kwargs.enable_thinking` and accepts
 *  the full effort range). Any GLM host OR GLM model gets `'glm_mapped'`
 *  (GLM accepts a narrow `reasoning_effort` enum but rejects the rich
 *  `thinking` object); everyone else gets the safe `reasoning_effort_only`
 *  default so future providers never trigger a literal_error from an unverified
 *  rich `thinking` object. Promote a host to `'both'` only after live
 *  confirmation. */
export function openAiCompatThinkingPolicy(platform: string, modelId?: string): OpenAiCompatThinkingPolicy {
  if (isSyntheticGlm52ThinkingModel(platform, modelId)) return 'glm52_synthetic';
  if (isGlmNvidiaThinkingModel(platform, modelId)) return 'glm_nvidia';
  if (glmMappedHosts().has(platform)) return 'glm_mapped';
  if (modelId && isGlmModel(modelId)) return 'glm_mapped';
  return 'reasoning_effort_only';
}

/** Decide which thinking fields to put on the outbound OpenAI-compat body,
 *  honoring the host's policy. Never forwards a field the host doesn't accept.
 *
 *  - `reasoning_effort_only`: emit `reasoning_effort`, derived from either the
 *    explicit `reasoning_effort` string or, when only a `thinking` object was
 *    sent, from `thinking.effort`. The rich `thinking` object is NEVER
 *    forwarded here — that's the field that triggers literal_errors.
 *  - `glm_mapped`: forward the (already per-model-redirected) effort verbatim
 *    and emit ONLY `reasoning_effort` — never the rich object (GLM).
 *  - `both`: forward `reasoning_effort` and `thinking` verbatim (only for
 *    hosts verified to accept the rich object).
 *  - `glm_nvidia`: GLM 5.2 on NVIDIA NIM — emit the
 *    `chat_template_kwargs.enable_thinking` switch that actually turns thinking
 *    on (a bare `reasoning_effort` is ignored), plus the effort verbatim across
 *    the full range. The rich `thinking` object is not forwarded (unverified on
 *    this host); its effort is extracted.
 *
 *  (#292.) */
export function openaiCompatThinkingBody(
  policy: OpenAiCompatThinkingPolicy,
  original: {
    reasoning_effort?: ThinkingEffort;
    thinking?: ThinkingConfig;
  } | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (policy === 'both') {
    if (original?.reasoning_effort) out.reasoning_effort = original.reasoning_effort;
    if (original?.thinking) out.thinking = original.thinking;
    return out;
  }

  // Resolve the effective effort: prefer explicit `reasoning_effort`, fall
  // back to `thinking.effort` so a client that only sent a `thinking` object
  // still has its level honored.
  const effort = original?.reasoning_effort ?? original?.thinking?.effort;

  if (policy === 'glm_nvidia') {
    // NVIDIA's GLM 5.2 ignores a bare `reasoning_effort` — thinking stays OFF
    // unless the request carries `chat_template_kwargs.enable_thinking: true`.
    // It accepts the full effort range (`minimal`…`max`) verbatim, so no clamp.
    // `clear_thinking: false` mirrors NVIDIA's documented sample. Confirmed
    // live against `z-ai/glm-5.2`. (#292)
    if (original?.thinking?.type === 'disabled') {
      // Honor an explicit disable — turn the switch off, send no effort.
      out.chat_template_kwargs = { enable_thinking: false, clear_thinking: false };
      return out;
    }
    // Enable when the caller asked for thinking (an effort level OR any
    // thinking object). With nothing requested, send nothing and let the model
    // use its default (thinking off).
    const requested = effort !== undefined || original?.thinking !== undefined;
    if (!requested) return out;
    out.chat_template_kwargs = { enable_thinking: true, clear_thinking: false };
    if (effort) out.reasoning_effort = effort;
    return out;
  }

  if (policy === 'glm52_synthetic') {
    // Synthetic-thinking gateways accept reasoning_effort as a string across
    // the full enum (none|minimal|low|medium|high|xhigh|max) and accepts `thinking` as a
    // boolean or {type} object. But reasoning_effort ALONE does not surface
    // reasoning_content — the thinking={type:enabled} switch is required.
    // So when the caller asks for thinking by any means, ensure the thinking
    // object reaches the gateway. Confirmed live.

    // Honor an explicit disable: forward verbatim, send no effort.
    if (original?.thinking?.type === 'disabled') {
      return { thinking: { type: 'disabled' } };
    }

    // Nothing requested — send nothing; these gateways default to no trace.
    const requested = effort !== undefined || original?.thinking !== undefined;
    if (!requested) return out;

    // Forward the caller's thinking object verbatim when present (they accept
    // boolean, {type:enabled}, {type:adaptive}); otherwise synthesize the
    // {type:enabled} switch that surfaces the trace.
    out.thinking = original?.thinking ?? { type: 'enabled' };
    // Forward effort verbatim (they accept the full 7-value enum; GLM's
    // narrow-enum restriction is handled per-model upstream, not here).
    if (effort) out.reasoning_effort = effort;
    return out;
  }

  if (policy === 'glm_mapped') {
    // GLM accepts ONLY `reasoning_effort` in {none,low,medium,high} and rejects
    // the rich `thinking` object. Which of the six levels this model accepts is
    // per-model data (`models.thinking_levels`) enforced by the proxy's
    // redirectThinkingRequest BEFORE the provider call — so whatever effort
    // survives to here is already in-set: forward it verbatim. Never forward
    // the rich object. If no effort was requested, send nothing and let GLM
    // use its default (which is thinking-enabled). (#292)
    if (effort) out.reasoning_effort = effort;
    return out;
  }

  // policy === 'reasoning_effort_only'
  if (effort) out.reasoning_effort = effort;
  return out;
}

// ─── Per-model supported-level redirect ───────────────────────────────────

/** The canonical effort scale, in increasing order. `models.thinking_levels`
 *  rows store a subset of these; redirect distance is measured as index
 *  distance on this scale. */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Nearest-enabled redirect for a single effort level. null/undefined/empty
 *  `enabled` => unrestricted, pass through. A requested level that IS enabled
 *  passes through; otherwise the enabled level with the smallest index
 *  distance on the THINKING_LEVELS scale wins. Exact ties ARE possible (a
 *  disabled level with enabled levels on both sides, e.g. medium requested,
 *  low + high enabled): the tie-break deterministically prefers the
 *  HIGHER-effort side — "next highest" — so a forced redirect never silently
 *  undershoots the reasoning depth the client asked for, and is independent
 *  of the storage order of `enabled`. Unknown entries in `enabled` are
 *  ignored; if nothing usable remains, the effort passes through unchanged. */
export function redirectEffort(
  enabled: string[] | null | undefined,
  effort?: ThinkingEffort,
): ThinkingEffort | undefined {
  if (!effort) return effort;
  if (!enabled || enabled.length === 0) return effort;
  if (enabled.includes(effort)) return effort;
  const requestedIdx = THINKING_LEVELS.indexOf(effort);
  let best: ThinkingEffort | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestIdx = -1;
  for (const level of enabled) {
    const idx = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
    if (idx === -1) continue;
    const dist = Math.abs(idx - requestedIdx);
    // Strictly nearer wins; on an exact tie the higher-effort level wins —
    // independent of the iteration/storage order of `enabled`.
    if (dist < bestDist || (dist === bestDist && idx > bestIdx)) {
      bestDist = dist;
      bestIdx = idx;
      best = THINKING_LEVELS[idx];
    }
  }
  return best ?? effort;
}

/** Force-disable token stored in `models.thinking_levels`. Exclusive by API
 *  validation (`["off"]` alone) — it is a capability switch, not an effort:
 *  an off model is advertised as non-reasoning and effort-bearing requests
 *  are rejected at the gateway instead of redirected. */
export const THINKING_OFF = 'off';

/** Request-time view of `models.thinking_levels`:
 *  - `unrestricted`: NULL/malformed column — every level passes through.
 *  - `levels`: operator-selected subset; out-of-set efforts redirect.
 *  - `off`: operator force-disabled the model's thinking entirely. */
export type ThinkingPolicy =
  | { kind: 'unrestricted' }
  | { kind: 'levels'; levels: ThinkingEffort[] }
  | { kind: 'off' };

/** Resolves the stored column into a request-time policy. Unknown tokens are
 *  dropped; a stored 'off' wins over any levels mixed in defensively (the API
 *  never writes such rows). Explicit-but-empty arrays cannot be saved via the
 *  API and resolve to unrestricted rather than silently disabling a model. */
export function resolveThinkingPolicy(raw: string | null | undefined): ThinkingPolicy {
  if (!raw) return { kind: 'unrestricted' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { kind: 'unrestricted' };
    const tokens = parsed.filter((l): l is string => typeof l === 'string');
    if (tokens.includes(THINKING_OFF)) return { kind: 'off' };
    const levels = tokens.filter((l): l is ThinkingEffort =>
      (THINKING_LEVELS as readonly string[]).includes(l));
    if (levels.length === 0) return { kind: 'unrestricted' };
    return { kind: 'levels', levels };
  } catch {
    return { kind: 'unrestricted' };
  }
}

/** Replacement thinking fields after a redirect (absent = forward as-is). */
export type ThinkingRequestRewrite = {
  reasoning_effort?: ThinkingEffort;
  thinking?: ThinkingConfig;
};

/** Outcome of applying a model's {@link ThinkingPolicy} to a request's
 *  thinking knobs. */
export type ThinkingRequestDecision =
  | { ok: true; rewrite?: ThinkingRequestRewrite }
  | { ok: false; error: string };

/** Applies the policy to the request's thinking surfaces:
 *  - No thinking surface present (`reasoning_effort` nor `thinking` object)
 *    → pass; "auto"/omitted is not one of the six levels and is never touched.
 *  - `off` policy → REJECT whenever the client ATTEMPTS thinking: any effort
 *    level, or a `thinking` object whose `type !== 'disabled'` (including
 *    Anthropic-style budget_tokens-only requests). An explicit
 *    `{type:'disabled'}` passes — the client is asking for exactly what the
 *    operator already enforced. Force-disabled means unsupported, not
 *    redirected.
 *  - `unrestricted` → pass verbatim.
 *  - `levels` → nearest-enabled redirect (see {@link redirectEffort}); when a
 *    redirect occurs the effective effort (`thinking.effort` wins over
 *    `reasoning_effort`, matching normalizeThinking) is rewritten on BOTH
 *    surfaces so no downstream reader (openaiCompatThinkingBody prefers
 *    reasoning_effort) sees a stale value; a present `thinking` object is
 *    shallow-cloned with only its `effort` replaced — type/budget/display
 *    preserved verbatim. */
export function applyThinkingPolicy(
  policy: ThinkingPolicy,
  req?: { reasoning_effort?: ThinkingEffort; thinking?: ThinkingConfig },
): ThinkingRequestDecision {
  if (!req || (!req.reasoning_effort && !req.thinking)) return { ok: true };
  if (policy.kind === 'off') {
    // Only an ATTEMPT to enable is a contract violation; an explicit
    // {type:'disabled'} asks for exactly what the operator already enforced.
    const triesToEnable =
      !!req.reasoning_effort || (req.thinking !== undefined && req.thinking.type !== 'disabled');
    if (triesToEnable) {
      return {
        ok: false,
        error:
          "This model has thinking disabled by the gateway operator; requests must not include 'reasoning_effort' or 'thinking'.",
      };
    }
    return { ok: true };
  }
  if (policy.kind === 'unrestricted') return { ok: true };
  const requested = req.thinking?.effort ?? req.reasoning_effort;
  if (!requested) return { ok: true };
  const redirected = redirectEffort(policy.levels, requested);
  if (redirected === requested) return { ok: true };
  if (req.thinking && req.thinking.effort !== undefined) {
    return {
      ok: true,
      rewrite: { reasoning_effort: redirected, thinking: { ...req.thinking, effort: redirected } },
    };
  }
  if (req.thinking) {
    // Effort came from `reasoning_effort`; the thinking object carries no
    // level of its own — forward it verbatim alongside the rewritten field.
    return { ok: true, rewrite: { reasoning_effort: redirected, thinking: req.thinking } };
  }
  return { ok: true, rewrite: { reasoning_effort: redirected } };
}

/** Parses a stored `models.thinking_levels` JSON string for dashboard/API
 *  responses. Missing/malformed/non-array => full six-level default; unknown
 *  entries are dropped; a stored 'off' normalizes to ['off'] alone so the UI
 *  renders exactly the Off toggle selected. An emptied result is returned
 *  as-is — it renders as zero selected toggles, and the API's min(1)
 *  validation blocks re-saving that state. */
export function parseStoredThinkingLevels(raw: string | null | undefined): string[] {
  if (!raw) return [...THINKING_LEVELS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...THINKING_LEVELS];
    const tokens = parsed.filter((l): l is string => typeof l === 'string');
    if (tokens.includes(THINKING_OFF)) return [THINKING_OFF];
    return tokens.filter((l): l is (typeof THINKING_LEVELS)[number] =>
      (THINKING_LEVELS as readonly string[]).includes(l));
  } catch {
    return [...THINKING_LEVELS];
  }
}
