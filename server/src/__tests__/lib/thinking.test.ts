import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalizeThinking,
  anthropicThinking,
  geminiThinkingConfig,
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
