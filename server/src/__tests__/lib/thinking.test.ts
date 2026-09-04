import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalizeThinking,
  anthropicThinking,
  geminiThinkingConfig,
  openaiCompatThinkingBody,
  openAiCompatThinkingPolicy,
  isGlmModel,
  isGlmNvidiaThinkingModel,
  THINKING_LEVELS,
  redirectEffort,
  applyThinkingPolicy,
  resolveThinkingPolicy,
  parseStoredThinkingLevels,
  THINKING_OFF,
} from '../../lib/thinking.js';

// `thinking` is the unified inbound knob. The translators here emit wire-
// shape fragments (`thinking` + `output_config` for Anthropic, etc.) that
// per-provider code folds into the final body. Tests cover all four real
// provider paths plus the unified effort/type normalization.

describe('normalizeThinking', () => {
  it('returns undefined when neither field is set', () => {
    expect(normalizeThinking({})).toBeUndefined();
  });

  it('treats bare `reasoning_effort` as enable-implied', () => {
    const out = normalizeThinking({ reasoning_effort: 'high' });
    expect(out).toEqual({ effort: 'high', enabled: true });
  });

  it('treats `thinking.type=disabled` explicitly as disabled', () => {
    const out = normalizeThinking({ thinking: { type: 'disabled' } });
    expect(out?.enabled).toBe(false);
  });

  it('treats `thinking.type=adaptive` as enabled with the adaptive flag', () => {
    const out = normalizeThinking({ thinking: { type: 'adaptive', effort: 'medium' } });
    expect(out).toMatchObject({ adaptive: true, enabled: true, effort: 'medium' });
  });

  it('treats `thinking.budget` as budget', () => {
    const out = normalizeThinking({ thinking: { type: 'enabled', budget: 5000 } });
    expect(out).toMatchObject({ enabled: true, budget: 5000 });
  });

  it('merges explicit effort into enabled-implied view when only reasoning_effort is set', () => {
    const out = normalizeThinking({ reasoning_effort: 'low' });
    expect(out).toMatchObject({ enabled: true, effort: 'low' });
  });
});

describe('anthropicThinking', () => {
  it('emits thinking=enabled with budget_tokens when budget is set', () => {
    const out = anthropicThinking({
      enabled: true, effort: 'high', budget: 4000, display: 'summarized',
    });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 4000, display: 'summarized' });
    expect(out.output_config).toEqual({ effort: 'high' });
  });

  it('emits thinking=adaptive + output_config.effort on adaptive mode', () => {
    const out = anthropicThinking({ adaptive: true, effort: 'medium' });
    expect(out.thinking).toEqual({ type: 'adaptive' });
    expect(out.output_config).toEqual({ effort: 'medium' });
  });

  it('honors explicit disabled', () => {
    const out = anthropicThinking({ enabled: false });
    expect(out.thinking).toEqual({ type: 'disabled' });
    expect(out.output_config).toBeUndefined();
  });

  it('omits fields when nothing was set', () => {
    expect(anthropicThinking(undefined)).toEqual({});
  });
  // M33: type:'enabled' WITHOUT budget_tokens is a 400 from Anthropic.
  it('M33: effort-only enabled derives budget_tokens from effort', () => {
    const out = anthropicThinking({ enabled: true, effort: 'high' });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });
  it('M33: bare enabled clamps to the Anthropic floor of 1024', () => {
    const out = anthropicThinking({ enabled: true });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
  it('M33: minimal effort clamps to the floor (budget 0 is invalid when enabled)', () => {
    const out = anthropicThinking({ enabled: true, effort: 'minimal' });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
});

describe('geminiThinkingConfig', () => {
  it('emits thinkingBudget=0 to disable on 2.5-series', () => {
    expect(geminiThinkingConfig({ enabled: false }, 'gemini-2.5-flash'))
      .toEqual({ thinkingBudget: 0 });
  });

  it('emits thinkingLevel=minimal to disable on 3-series', () => {
    expect(geminiThinkingConfig({ enabled: false }, 'gemini-3-flash'))
      .toEqual({ thinkingLevel: 'minimal' });
  });

  it('emits thinkingLevel on 3-series when effort is set', () => {
    expect(geminiThinkingConfig({ enabled: true, effort: 'medium' }, 'gemini-3-flash'))
      .toMatchObject({ includeThoughts: true, thinkingLevel: 'medium' });
  });

  it('emits thinkingBudget on 2.5-series when effort is set', () => {
    expect(geminiThinkingConfig({ enabled: true, effort: 'low' }, 'gemini-2.5-flash'))
      .toMatchObject({ includeThoughts: true, thinkingBudget: 2048 });
  });

  it('H14: effort "minimal" on 2.5-series maps to a DEFINED budget (was silently dropped)', () => {
    const cfg = geminiThinkingConfig({ enabled: true, effort: 'minimal' }, 'gemini-2.5-flash');
    expect(cfg).toMatchObject({ includeThoughts: true });
    expect((cfg as Record<string, unknown>).thinkingBudget).toBe(0);
  });

  it('H14: every ThinkingEffort produces a defined 2.5 budget', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const cfg = geminiThinkingConfig({ enabled: true, effort }, 'gemini-2.5-pro') as Record<string, unknown>;
      expect(Number.isFinite(cfg.thinkingBudget as number)).toBe(true);
    }
  });

  it('uses explicit budget when no effort is set', () => {
    expect(geminiThinkingConfig({ enabled: true, budget: 4096 }, 'gemini-3-pro'))
      .toMatchObject({ includeThoughts: true, thinkingBudget: 4096 });
  });

  it('returns undefined when neither enabled nor disabled', () => {
    expect(geminiThinkingConfig(undefined, 'gemini-3-flash')).toBeUndefined();
  });
});

describe('openAiCompatThinkingPolicy', () => {
  it('returns "glm_mapped" for public GLM host platforms', () => {
    expect(openAiCompatThinkingPolicy('z-ai')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('zai')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('zhipu')).toBe('glm_mapped');
  });

  it('returns "reasoning_effort_only" for unknown hosts (safe default)', () => {
    expect(openAiCompatThinkingPolicy('nvidia')).toBe('reasoning_effort_only');
    expect(openAiCompatThinkingPolicy('groq')).toBe('reasoning_effort_only');
    expect(openAiCompatThinkingPolicy('some-future-provider')).toBe('reasoning_effort_only');
  });

  it('returns "glm_mapped" for a GLM model id even on a non-GLM host', () => {
    // nvidia/z-ai/glm-5.1 — a GLM model hosted on NVIDIA NIM must still get
    // GLM's narrow effort enum; the rich `thinking` object would 400. (#292)
    expect(openAiCompatThinkingPolicy('nvidia', 'z-ai/glm-5.1')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('openrouter', 'zai-org/glm-5.1-fp8')).toBe('glm_mapped');
  });

  it('returns "glm_nvidia" for GLM 5.2 on NVIDIA NIM (wins over glm_mapped) (#292)', () => {
    // NVIDIA's GLM 5.2 needs chat_template_kwargs.enable_thinking and accepts
    // the full effort range — distinct from GLM's own narrow-enum wrapper.
    expect(openAiCompatThinkingPolicy('nvidia', 'z-ai/glm-5.2')).toBe('glm_nvidia');
  });

  it('keeps GLM 5.2 on non-NVIDIA hosts on "glm_mapped" (the NVIDIA quirk is host-specific)', () => {
    expect(openAiCompatThinkingPolicy('openrouter', 'z-ai/glm-5.2')).toBe('glm_mapped');
    // GLM 5.1 on NVIDIA is unchanged — still the narrow-enum path.
    expect(openAiCompatThinkingPolicy('nvidia', 'z-ai/glm-5.1')).toBe('glm_mapped');
  });


  it('keeps GLM 5.2 on non-registered hosts unchanged (the synthetic switch is host-specific)', () => {
    expect(openAiCompatThinkingPolicy('nvidia', 'z-ai/glm-5.2')).toBe('glm_nvidia');
    expect(openAiCompatThinkingPolicy('openrouter', 'z-ai/glm-5.2')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('zhipu', 'glm-5.2')).toBe('glm_mapped');
  });
});

describe('env-registered thinking hosts', () => {
  let savedMapped: string | undefined;
  let savedSynthetic: string | undefined;
  beforeEach(() => {
    savedMapped = process.env.THINKING_GLM_MAPPED_HOSTS;
    savedSynthetic = process.env.THINKING_GLM52_SYNTHETIC_HOSTS;
    delete process.env.THINKING_GLM_MAPPED_HOSTS;
    delete process.env.THINKING_GLM52_SYNTHETIC_HOSTS;
  });
  afterEach(() => {
    if (savedMapped === undefined) delete process.env.THINKING_GLM_MAPPED_HOSTS;
    else process.env.THINKING_GLM_MAPPED_HOSTS = savedMapped;
    if (savedSynthetic === undefined) delete process.env.THINKING_GLM52_SYNTHETIC_HOSTS;
    else process.env.THINKING_GLM52_SYNTHETIC_HOSTS = savedSynthetic;
  });

  it('registers glm_mapped hosts via THINKING_GLM_MAPPED_HOSTS (entries trimmed)', () => {
    process.env.THINKING_GLM_MAPPED_HOSTS = 'env-host-a, env-host-b';
    expect(openAiCompatThinkingPolicy('env-host-a')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('env-host-b')).toBe('glm_mapped');
    // Public GLM wrappers stay registered; NVIDIA stays on its own path.
    expect(openAiCompatThinkingPolicy('zhipu')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('nvidia')).toBe('reasoning_effort_only');
  });

  it('registers the synthetic glm-5.2 switch via THINKING_GLM52_SYNTHETIC_HOSTS (host-scoped, model-scoped)', () => {
    process.env.THINKING_GLM52_SYNTHETIC_HOSTS = 'env-gateway';
    expect(openAiCompatThinkingPolicy('env-gateway', 'glm-5.2')).toBe('glm52_synthetic');
    expect(openAiCompatThinkingPolicy('env-gateway', 'z-ai/glm-5.2')).toBe('glm52_synthetic');
    // Non-GLM-5.2 models on a registered host keep the default policy.
    expect(openAiCompatThinkingPolicy('env-gateway', 'DeepSeek-V4-Pro')).toBe('reasoning_effort_only');
    expect(openAiCompatThinkingPolicy('env-gateway', 'MiniMax-M3')).toBe('reasoning_effort_only');
    // GLM 5.1 on the same host is plain glm_mapped (narrow enum, no switch).
    expect(openAiCompatThinkingPolicy('env-gateway', 'z-ai/glm-5.1')).toBe('glm_mapped');
    // The NVIDIA quirk still wins on NVIDIA; public wrappers are unaffected.
    expect(openAiCompatThinkingPolicy('nvidia', 'z-ai/glm-5.2')).toBe('glm_nvidia');
    expect(openAiCompatThinkingPolicy('zhipu', 'glm-5.2')).toBe('glm_mapped');
  });

  it('with both vars unset, unregistered hosts keep the safe default (env is the only registration path)', () => {
    expect(openAiCompatThinkingPolicy('env-host-a')).toBe('reasoning_effort_only');
    // The GLM model-id fallback still applies on unregistered hosts.
    expect(openAiCompatThinkingPolicy('env-gateway', 'glm-5.2')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('env-gateway', 'glm-5.2')).not.toBe('glm52_synthetic');
  });
});

describe('isGlmNvidiaThinkingModel', () => {
  it('matches GLM 5.2 on NVIDIA with any prefix/separator/case', () => {
    expect(isGlmNvidiaThinkingModel('nvidia', 'z-ai/glm-5.2')).toBe(true);
    expect(isGlmNvidiaThinkingModel('nvidia', 'GLM-5.2')).toBe(true);
    expect(isGlmNvidiaThinkingModel('nvidia', 'zai-org/glm_5_2')).toBe(true);
  });

  it('is scoped to NVIDIA + GLM 5.2 only', () => {
    expect(isGlmNvidiaThinkingModel('nvidia', 'z-ai/glm-5.1')).toBe(false); // wrong version
    expect(isGlmNvidiaThinkingModel('openrouter', 'z-ai/glm-5.2')).toBe(false); // wrong host
    expect(isGlmNvidiaThinkingModel('nvidia', undefined)).toBe(false); // no model
    expect(isGlmNvidiaThinkingModel('nvidia', 'qwen/qwen3-coder-480b')).toBe(false); // non-GLM
  });
});

describe('isGlmModel', () => {
  it('matches GLM 4.x and 5.x ids with org prefixes', () => {
    expect(isGlmModel('z-ai/glm-5.1')).toBe(true);
    expect(isGlmModel('zai-org/GLM-5.1-FP8')).toBe(true);
    expect(isGlmModel('glm-4.5-flash')).toBe(true);
    expect(isGlmModel('glm-4-plus')).toBe(true);
  });

  it('does not match unrelated ids that merely contain "glm"', () => {
    expect(isGlmModel('glmist-7b')).toBe(false);
    expect(isGlmModel('llama-3.3-70b')).toBe(false);
  });
});

describe('openaiCompatThinkingBody', () => {
  it('emits reasoning_effort shorthand when only that is set (default policy)', () => {
    const out = openaiCompatThinkingBody('reasoning_effort_only', { reasoning_effort: 'medium' });
    expect(out).toEqual({ reasoning_effort: 'medium' });
  });

  it('derives reasoning_effort from thinking.effort when only the rich object was sent', () => {
    const out = openaiCompatThinkingBody(
      'reasoning_effort_only',
      { thinking: { type: 'enabled', effort: 'high' } },
    );
    expect(out).toEqual({ reasoning_effort: 'high' });
  });

  it('forwards effort verbatim under "glm_mapped" — the per-model level set is enforced upstream (#292)', () => {
    // GLM's narrow enum is enforced by redirectThinkingRequest (per-model
    // `models.thinking_levels`) BEFORE the provider call, so whatever survives
    // to openaiCompatThinkingBody is in-set and forwarded as-is.
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'max' })).toEqual({ reasoning_effort: 'max' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'xhigh' })).toEqual({ reasoning_effort: 'xhigh' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'minimal' })).toEqual({ reasoning_effort: 'minimal' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'low' })).toEqual({ reasoning_effort: 'low' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'medium' })).toEqual({ reasoning_effort: 'medium' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'high' })).toEqual({ reasoning_effort: 'high' });
  });

  it('DROPS the rich thinking object for GLM (glm_mapped) but keeps the effort', () => {
    // The rich `thinking` object (type/effort/budget) is what triggers GLM's
    // literal_error — it must never be forwarded. The effective effort is
    // extracted and emitted as reasoning_effort. (#292)
    expect(openaiCompatThinkingBody(
      'glm_mapped',
      { reasoning_effort: 'xhigh', thinking: { type: 'enabled', effort: 'xhigh', budget: 4000 } },
    )).toEqual({ reasoning_effort: 'xhigh' });
    // effort from the rich object alone (no top-level reasoning_effort):
    expect(openaiCompatThinkingBody(
      'glm_mapped',
      { thinking: { type: 'enabled', effort: 'minimal' } },
    )).toEqual({ reasoning_effort: 'minimal' });
  });

  it('emits nothing for GLM when no effort was requested (GLM default = thinking on)', () => {
    expect(openaiCompatThinkingBody('glm_mapped', undefined)).toEqual({});
  });

  it('forwards both fields verbatim under the "both" policy', () => {
    const obj = { type: 'enabled' as const, effort: 'high' as const, budget: 4000 };
    const out = openaiCompatThinkingBody('both', { reasoning_effort: 'high', thinking: obj });
    expect(out).toEqual({ reasoning_effort: 'high', thinking: obj });
  });

  it('returns an empty object when no thinking info is present', () => {
    expect(openaiCompatThinkingBody('reasoning_effort_only', undefined)).toEqual({});
  });

  describe('glm_nvidia policy — GLM 5.2 on NVIDIA NIM (#292)', () => {
    it('emits chat_template_kwargs.enable_thinking + the effort VERBATIM across the full range', () => {
      // NVIDIA GLM 5.2 accepts minimal…max unchanged (no clamp) but only thinks
      // when enable_thinking is set. Confirmed live against z-ai/glm-5.2.
      for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        expect(openaiCompatThinkingBody('glm_nvidia', { reasoning_effort: effort })).toEqual({
          chat_template_kwargs: { enable_thinking: true, clear_thinking: false },
          reasoning_effort: effort,
        });
      }
    });

    it('derives the effort from a rich thinking object (still not forwarded verbatim)', () => {
      expect(openaiCompatThinkingBody('glm_nvidia', { thinking: { type: 'enabled', effort: 'high' } })).toEqual({
        chat_template_kwargs: { enable_thinking: true, clear_thinking: false },
        reasoning_effort: 'high',
      });
    });

    it('enables thinking (no effort) when a thinking object is present without an effort level', () => {
      expect(openaiCompatThinkingBody('glm_nvidia', { thinking: { type: 'enabled' } })).toEqual({
        chat_template_kwargs: { enable_thinking: true, clear_thinking: false },
      });
    });

    it('honors an explicit disable — turns enable_thinking off, sends no effort', () => {
      expect(openaiCompatThinkingBody('glm_nvidia', { thinking: { type: 'disabled' } })).toEqual({
        chat_template_kwargs: { enable_thinking: false, clear_thinking: false },
      });
    });

    it('sends nothing when no thinking was requested (model default = off)', () => {
      expect(openaiCompatThinkingBody('glm_nvidia', undefined)).toEqual({});
      expect(openaiCompatThinkingBody('glm_nvidia', {})).toEqual({});
    });
  });
});

describe('openaiCompatThinkingBody — glm52_synthetic (synthesizes thinking to surface reasoning_content)', () => {
  it('synthesizes thinking={type:enabled} when only reasoning_effort is sent (the common OpenAI-SDK case)', () => {
    expect(openaiCompatThinkingBody('glm52_synthetic', { reasoning_effort: 'high' }))
      .toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('forwards the full effort enum verbatim — no glm_mapped clamping', () => {
    expect(openaiCompatThinkingBody('glm52_synthetic', { reasoning_effort: 'max' }).reasoning_effort).toBe('max');
    expect(openaiCompatThinkingBody('glm52_synthetic', { reasoning_effort: 'xhigh' }).reasoning_effort).toBe('xhigh');
    expect(openaiCompatThinkingBody('glm52_synthetic', { reasoning_effort: 'minimal' }).reasoning_effort).toBe('minimal');
  });

  it('forwards an explicit thinking object verbatim and extracts its effort', () => {
    const out = openaiCompatThinkingBody('glm52_synthetic', { thinking: { type: 'enabled', effort: 'max' } });
    expect(out.thinking).toEqual({ type: 'enabled', effort: 'max' });
    expect(out.reasoning_effort).toBe('max');
  });

  it('honors an explicit disable (early return, no effort forwarded)', () => {
    expect(openaiCompatThinkingBody('glm52_synthetic', { thinking: { type: 'disabled' } }))
      .toEqual({ thinking: { type: 'disabled' } });
  });

  it('emits nothing when neither knob is set', () => {
    expect(openaiCompatThinkingBody('glm52_synthetic', undefined)).toEqual({});
  });
});

describe('THINKING_LEVELS', () => {
  it('is the canonical six-level scale in increasing order', () => {
    expect([...THINKING_LEVELS]).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('redirectEffort', () => {
  it('passes through when the level set is null/undefined/empty (unrestricted)', () => {
    expect(redirectEffort(null, 'max')).toBe('max');
    expect(redirectEffort(undefined, 'max')).toBe('max');
    expect(redirectEffort([], 'max')).toBe('max');
  });

  it('passes through an enabled level unchanged', () => {
    expect(redirectEffort(['low', 'medium', 'high'], 'high')).toBe('high');
  });

  it('redirects a disabled level to the scale-nearest enabled level (xhigh → high)', () => {
    expect(redirectEffort(['minimal', 'low', 'medium', 'high'], 'xhigh')).toBe('high');
    expect(redirectEffort(['low', 'medium', 'high'], 'max')).toBe('high');
  });

  it('redirects downward across the low edge (minimal → low)', () => {
    expect(redirectEffort(['low', 'medium', 'high'], 'minimal')).toBe('low');
  });

  it('resolves two-sided gaps by nearest index; exact ties prefer the HIGHER level', () => {
    // Not a tie: medium requested — low is distance 1, max is distance 3.
    expect(redirectEffort(['low', 'max'], 'medium')).toBe('low');
    // Not a tie: low requested — minimal distance 1, high distance 2.
    expect(redirectEffort(['minimal', 'high'], 'low')).toBe('minimal');
    // Exact ties (enabled levels equidistant on both sides of the gap)
    // resolve to the next-highest level.
    expect(redirectEffort(['low', 'high'], 'medium')).toBe('high');
    expect(redirectEffort(['medium', 'xhigh'], 'high')).toBe('xhigh');
  });

  it('tie-break is independent of the storage order of the enabled array', () => {
    expect(redirectEffort(['high', 'low'], 'medium')).toBe('high');
    expect(redirectEffort(['xhigh', 'medium'], 'high')).toBe('xhigh');
  });

  it('ignores unknown entries and passes through when nothing usable remains', () => {
    expect(redirectEffort(['bogus', 'levels'], 'max')).toBe('max');
  });

  it('returns undefined effort untouched (auto passthrough)', () => {
    expect(redirectEffort(['low'], undefined)).toBeUndefined();
  });
});

describe('resolveThinkingPolicy', () => {
  it('maps NULL/malformed/non-array columns to unrestricted', () => {
    expect(resolveThinkingPolicy(null)).toEqual({ kind: 'unrestricted' });
    expect(resolveThinkingPolicy(undefined)).toEqual({ kind: 'unrestricted' });
    expect(resolveThinkingPolicy('not json')).toEqual({ kind: 'unrestricted' });
    expect(resolveThinkingPolicy('{"a":1}')).toEqual({ kind: 'unrestricted' });
  });

  it('resolves a stored subset, dropping unknown tokens', () => {
    expect(resolveThinkingPolicy('["low","high","max"]')).toEqual({ kind: 'levels', levels: ['low', 'high', 'max'] });
    expect(resolveThinkingPolicy('["low","bogus"]')).toEqual({ kind: 'levels', levels: ['low'] });
  });

  it('resolves an explicit off and lets it win over defensively-mixed levels', () => {
    expect(resolveThinkingPolicy('["off"]')).toEqual({ kind: 'off' });
    expect(resolveThinkingPolicy('["off","low"]')).toEqual({ kind: 'off' });
  });

  it('treats an explicit-but-empty array as unrestricted (never silently disabled)', () => {
    expect(resolveThinkingPolicy('[]')).toEqual({ kind: 'unrestricted' });
  });
});

describe('applyThinkingPolicy', () => {
  const req = { reasoning_effort: 'high' as const };

  it('passes when no thinking surface is present (auto/omitted is never touched)', () => {
    expect(applyThinkingPolicy({ kind: 'levels', levels: ['low'] }, undefined)).toEqual({ ok: true });
    expect(applyThinkingPolicy({ kind: 'off' }, {})).toEqual({ ok: true });
    expect(applyThinkingPolicy({ kind: 'levels', levels: ['low'] }, { thinking: { type: 'disabled' } })).toEqual({ ok: true });
  });

  it('REJECTS attempts to enable thinking on an off model — effort or enabled-type objects', () => {
    const out = applyThinkingPolicy({ kind: 'off' }, { reasoning_effort: 'low' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/thinking disabled/i);
    const objOnly = applyThinkingPolicy({ kind: 'off' }, { thinking: { type: 'enabled', budget: 4000 } });
    expect(objOnly.ok).toBe(false);
  });

  it('ALLOWS an explicit {type:disabled} under an off policy — client asks for what the operator enforced', () => {
    expect(applyThinkingPolicy({ kind: 'off' }, { thinking: { type: 'disabled' } })).toEqual({ ok: true });
    // Adaptive/enabled types are enable attempts even without budget/effort.
    expect(applyThinkingPolicy({ kind: 'off' }, { thinking: { type: 'adaptive' } }).ok).toBe(false);
  });

  it('passes unrestricted requests through verbatim', () => {
    expect(applyThinkingPolicy({ kind: 'unrestricted' }, { reasoning_effort: 'max' })).toEqual({ ok: true });
  });

  it('returns identity when the requested level is already enabled', () => {
    expect(applyThinkingPolicy({ kind: 'levels', levels: ['low', 'high'] }, req)).toEqual({ ok: true });
  });

  it('rewrites reasoning_effort when redirected', () => {
    const out = applyThinkingPolicy({ kind: 'levels', levels: ['low', 'medium', 'high'] }, { reasoning_effort: 'xhigh' });
    expect(out).toEqual({ ok: true, rewrite: { reasoning_effort: 'high' } });
  });

  it('rewrites thinking.effort and preserves type/budget verbatim when redirected', () => {
    const out = applyThinkingPolicy(
      { kind: 'levels', levels: ['low', 'medium', 'high'] },
      { thinking: { type: 'enabled', effort: 'xhigh', budget: 4000 } },
    );
    expect(out).toEqual({
      ok: true,
      rewrite: { reasoning_effort: 'high', thinking: { type: 'enabled', effort: 'high', budget: 4000 } },
    });
  });

  it('rewrites BOTH surfaces so no downstream reader sees a divergent value', () => {
    // openaiCompatThinkingBody prefers reasoning_effort over thinking.effort;
    // leaving either behind would leak an unsupported level to GLM.
    const out = applyThinkingPolicy(
      { kind: 'levels', levels: ['low', 'medium', 'high'] },
      { reasoning_effort: 'max', thinking: { type: 'enabled', effort: 'max', budget: 1000 } },
    );
    expect(out.ok).toBe(true);
    if (out.ok && out.rewrite) {
      expect(out.rewrite.reasoning_effort).toBe('high');
      expect(out.rewrite.thinking).toEqual({ type: 'enabled', effort: 'high', budget: 1000 });
    }
  });

  it('leaves a thinking object without its own effort alone but still rewrites reasoning_effort', () => {
    const out = applyThinkingPolicy(
      { kind: 'levels', levels: ['low', 'medium', 'high'] },
      { reasoning_effort: 'minimal', thinking: { type: 'enabled', budget: 512 } },
    );
    expect(out).toEqual({
      ok: true,
      rewrite: { reasoning_effort: 'low', thinking: { type: 'enabled', budget: 512 } },
    });
  });
});

describe('parseStoredThinkingLevels — off normalization', () => {
  it('keeps the six-level default for untouched rows', () => {
    expect(parseStoredThinkingLevels(null)).toEqual([...THINKING_LEVELS]);
  });

  it('normalizes stored off to [off] alone, mixed input included', () => {
    expect(parseStoredThinkingLevels('["off"]')).toEqual(['off']);
    expect(parseStoredThinkingLevels('["off","low"]')).toEqual(['off']);
  });

  it('still drops unknown tokens from plain subsets', () => {
    expect(parseStoredThinkingLevels('["low","weird","max"]')).toEqual(['low', 'max']);
  });

  it('exposes THINKING_OFF as the literal off token', () => {
    expect(THINKING_OFF).toBe('off');
  });
});
