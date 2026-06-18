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
    if (normalized.budget !== undefined) t.budget_tokens = normalized.budget;
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
const GEMINI_BUDGET: Record<GeminiEffort, number> = {
  max: 24576,
  xhigh: 24576,
  high: 16384,
  medium: 8192,
  low: 2048,
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
      // `minimal` was already filtered into the 2.5 disable path above;
      // remaining values are bounded by GeminiEffort.
      cfg.thinkingBudget = GEMINI_BUDGET[normalized.effort as GeminiEffort];
    }
  }
  return cfg;
}

// ─── OpenAI-compat ────────────────────────────────────────────────────────

// Per-host thinking-field policy for OpenAI-compat providers. Each host
// accepts a different subset of the thinking vocabulary, and forwarding a
// field the host rejects produces a 400 — notably GLM-5.1 on GlmAggregatorB
// returns a pydantic `literal_error` for the rich Anthropic-style `thinking`
// object, killing every request (#292). The gateway therefore never forwards
// a field unless the host is known to accept it.
//
//   'reasoning_effort_only'  default — emit the single `reasoning_effort`
//                            string (derived from `reasoning_effort` OR
//                            `thinking.effort`). Most OpenAI-compat hosts
//                            (NVIDIA, OpenRouter, Groq, Cerebras, …) accept it.
//   'none'                   GLM hosts — emit NOTHING. GLM's API rejects both
//                            `reasoning_effort` (unknown field) and the rich
//                            `thinking` object (literal_error on its
//                            narrower enum), so the only safe move is to let
//                            GLM run with its own default reasoning.
//   'both'                   hosts verified to accept the rich `thinking`
//                            object alongside `reasoning_effort`. Reserved for
//                            explicit allowlisting once a host is confirmed.
export type OpenAiCompatThinkingPolicy =
  | 'reasoning_effort_only'   // default — emit reasoning_effort verbatim
  | 'glm_mapped'              // GLM — map effort to GLM's narrow enum, drop the rich object
  | 'both';                   // forward reasoning_effort + thinking verbatim (verified hosts only);

// Legacy alias kept for clarity in comments; 'none' is now 'glm_mapped' because
// GLM does accept a (narrow) reasoning_effort — we just have to map it.

// GLM-family hosts. GLM's OpenAI-compat wrapper accepts ONLY
// `reasoning_effort` and ONLY the values `none | low | medium | high` — it
// rejects `max`, `xhigh`, `minimal` with a pydantic literal_error, and rejects
// the rich Anthropic-style `thinking` object outright. So for GLM we MAP the
// unified effort onto GLM's allowed enum and never forward the rich object.
// (#292 — confirmed live against GlmAggregatorB's zai-org/GLM-5.1-FP8.)
const GLM_HOST_PLATFORMS = new Set<string>([
  'glmaggregatorb', // zai-org/GLM-5.1-FP8
  'z-ai',          // GLM hosted on NVIDIA NIM
  'zai',
  'glmaggregatora',    // z-ai/glm-5.1
  'zhipu',         // Zhipu/GLM native
]);

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

/** Resolve the thinking-field policy for an OpenAI-compat host. `platform`
 *  is the provider slug; `modelId` is the model being called. A GLM host OR
 *  GLM model gets `'glm_mapped'` (GLM accepts a narrow `reasoning_effort`
 *  enum but rejects the rich `thinking` object); everyone else gets the safe
 *  `reasoning_effort_only` default so future providers never trigger a
 *  literal_error from an unverified rich `thinking` object. Promote a host to
 *  `'both'` only after live confirmation. */
export function openAiCompatThinkingPolicy(platform: string, modelId?: string): OpenAiCompatThinkingPolicy {
  if (GLM_HOST_PLATFORMS.has(platform)) return 'glm_mapped';
  if (modelId && isGlmModel(modelId)) return 'glm_mapped';
  return 'reasoning_effort_only';
}

/** Map a unified effort level onto GLM's accepted enum (`low|medium|high`).
 *  GLM rejects `max` and `xhigh` (literal_error) and has no `minimal` slot, so
 *  we clamp the out-of-range levels into GLM's range WITHOUT disabling
 *  thinking — `max`/`xhigh` → `high` (most thinking GLM offers), `minimal` →
 *  `low` (least thinking, but still on). The user's intent (more vs less
 *  thinking) is preserved; thinking is never turned off by the mapping.
 *  Confirmed live against GlmAggregatorB GLM-5.1-FP8. (#292) */
function mapGlmEffort(effort: ThinkingEffort): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'minimal':
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh':
    case 'max': return 'high';
    default: return 'high';
  }
}

/** Decide which thinking fields to put on the outbound OpenAI-compat body,
 *  honoring the host's policy. Never forwards a field the host doesn't accept.
 *
 *  - `none`: drop everything (GLM).
 *  - `reasoning_effort_only`: emit `reasoning_effort`, derived from either the
 *    explicit `reasoning_effort` string or, when only a `thinking` object was
 *    sent, from `thinking.effort`. The rich `thinking` object is NEVER
 *    forwarded here — that's the field that triggers literal_errors.
 *  - `both`: forward `reasoning_effort` and `thinking` verbatim (only for
 *    hosts verified to accept the rich object).
 *
 *  (#292 — previously the live path forwarded both verbatim unconditionally;
 *  this helper was defined but never imported, i.e. dead code.) */
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

  if (policy === 'glm_mapped') {
    // GLM accepts ONLY `reasoning_effort` in {none,low,medium,high} and rejects
    // the rich `thinking` object. Map the unified effort onto GLM's enum; never
    // forward the rich object. If no effort was requested, send nothing and let
    // GLM use its default (which is thinking-enabled). (#292)
    if (effort) out.reasoning_effort = mapGlmEffort(effort);
    return out;
  }

  // policy === 'reasoning_effort_only'
  if (effort) out.reasoning_effort = effort;
  return out;
}
