import { describe, it, expect } from 'vitest';
import {
  normalizeThinking,
  anthropicThinking,
  geminiThinkingConfig,
  openaiCompatThinkingBody,
  openAiCompatThinkingPolicy,
  isGlmModel,
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

  it('uses explicit budget when no effort is set', () => {
    expect(geminiThinkingConfig({ enabled: true, budget: 4096 }, 'gemini-3-pro'))
      .toMatchObject({ includeThoughts: true, thinkingBudget: 4096 });
  });

  it('returns undefined when neither enabled nor disabled', () => {
    expect(geminiThinkingConfig(undefined, 'gemini-3-flash')).toBeUndefined();
  });
});

describe('openAiCompatThinkingPolicy', () => {
  it('returns "glm_mapped" for GLM host platforms', () => {
    expect(openAiCompatThinkingPolicy('glmaggregatorb')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('z-ai')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('zai')).toBe('glm_mapped');
    expect(openAiCompatThinkingPolicy('glmaggregatora')).toBe('glm_mapped');
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

  it('clamps unsupported effort levels into GLM range under "glm_mapped" — never disables thinking (#292)', () => {
    // GLM accepts ONLY low|medium|high. max/xhigh → high, minimal → low.
    // Thinking stays ON; the user's more/less intent is preserved.
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'max' })).toEqual({ reasoning_effort: 'high' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'xhigh' })).toEqual({ reasoning_effort: 'high' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'minimal' })).toEqual({ reasoning_effort: 'low' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'low' })).toEqual({ reasoning_effort: 'low' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'medium' })).toEqual({ reasoning_effort: 'medium' });
    expect(openaiCompatThinkingBody('glm_mapped', { reasoning_effort: 'high' })).toEqual({ reasoning_effort: 'high' });
  });

  it('DROPS the rich thinking object for GLM (glm_mapped) but keeps the mapped effort', () => {
    // The rich `thinking` object (type/effort/budget) is what triggers GLM's
    // literal_error — it must never be forwarded. The effort is extracted and
    // mapped to GLM's enum instead. (#292)
    expect(openaiCompatThinkingBody(
      'glm_mapped',
      { reasoning_effort: 'xhigh', thinking: { type: 'enabled', effort: 'xhigh', budget: 4000 } },
    )).toEqual({ reasoning_effort: 'high' });
    // effort from the rich object alone (no top-level reasoning_effort):
    expect(openaiCompatThinkingBody(
      'glm_mapped',
      { thinking: { type: 'enabled', effort: 'minimal' } },
    )).toEqual({ reasoning_effort: 'low' });
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
});
