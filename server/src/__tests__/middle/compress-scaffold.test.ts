import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  detectOffLimits,
  isJsonBlock,
  isOffLimitsRole,
  intersectsOffLimits,
  mustKeepMatches,
  mustKeepRe,
  type Span,
} from '../../middle/compression/protect.js';
import {
  compressStep,
  compressSafely,
  countTokensEstimate,
  emptyMetrics,
  recordStep,
  type CompressionMetrics,
} from '../../middle/compression/metrics.js';
import {
  getCompressionConfig,
  clearCompressionConfigCache,
} from '../../middle/compression/index.js';

beforeAll(() => {
  initDb(':memory:');
});
// ── Off-limits span detection ──────────────────────────────────────────────

describe('B1-1: off-limits span detection', () => {
  it('detects fenced code blocks', () => {
    const text = 'before\n```js\nconst x = 1;\n```\nafter';
    const spans = detectOffLimits(text);
    expect(spans.length).toBeGreaterThanOrEqual(1);
    // The fenced block is within a span
    const fenceContent = text.slice(spans[0].start, spans[0].end);
    expect(fenceContent).toContain('const x = 1;');
  });

  it('detects tilde-fenced code blocks', () => {
    const text = '~~~python\nprint("hello")\n~~~';
    const spans = detectOffLimits(text);
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(text.slice(spans[0].start, spans[0].end)).toContain('print');
  });

  it('detects inline backticks', () => {
    const text = 'use `npm test` to run tests';
    const spans = detectOffLimits(text);
    expect(spans.some(s => text.slice(s.start, s.end) === '`npm test`')).toBe(true);
  });

  it('detects B2 redaction placeholders', () => {
    const text = 'My key is ⟦R1:974c7b⟧ and another ⟦R7:a3f2c9⟧';
    const spans = detectOffLimits(text);
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  it('detects mangled placeholder variants', () => {
    const text = 'Mangled: [R1:974c7b] and spaced: ⟦ R1:974c7b ⟧';
    const spans = detectOffLimits(text);
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  it('detects compression sentinels', () => {
    const text = 'Result: ⟦C7:<<crushed 5 rows, hash abc12345>>⟧ done';
    const spans = detectOffLimits(text);
    expect(spans.length).toBeGreaterThanOrEqual(1);
  });

  it('merges overlapping spans', () => {
    // Inline backtick inside a fenced block → one merged span
    const text = '```\n`code` inside fence\n```';
    const spans = detectOffLimits(text);
    expect(spans.length).toBeGreaterThanOrEqual(1);
    // No overlaps
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it('returns empty for plain text with no off-limits content', () => {
    const text = 'This is just plain text with no code or placeholders.';
    const spans = detectOffLimits(text);
    expect(spans).toEqual([]);
  });
});

// ── JSON block detection ────────────────────────────────────────────────────

describe('B1-1: JSON block detection', () => {
  it('detects a JSON object', () => {
    expect(isJsonBlock('{"key": "value"}')).toBe(true);
  });
  it('detects a JSON array', () => {
    expect(isJsonBlock('[1, 2, 3]')).toBe(true);
  });
  it('detects nested JSON', () => {
    expect(isJsonBlock('{"a": [1, {"b": 2}]}')).toBe(true);
  });
  it('rejects plain text', () => {
    expect(isJsonBlock('hello world')).toBe(false);
  });
  it('rejects partial JSON', () => {
    expect(isJsonBlock('{"key":')).toBe(false);
  });
});

// ── Role classifier ─────────────────────────────────────────────────────────

describe('B1-1: off-limits role classifier', () => {
  it('marks role:tool as off-limits', () => {
    expect(isOffLimitsRole('tool')).toBe(true);
  });
  it('does not mark role:user as off-limits', () => {
    expect(isOffLimitsRole('user')).toBe(false);
  });
  it('does not mark role:assistant as off-limits', () => {
    expect(isOffLimitsRole('assistant')).toBe(false);
  });
});

// ── Intersection check ─────────────────────────────────────────────────────

describe('B1-1: intersectsOffLimits', () => {
  const spans: Span[] = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
  it('detects overlap', () => {
    expect(intersectsOffLimits(5, 15, spans)).toBe(true);
    expect(intersectsOffLimits(15, 25, spans)).toBe(true);
    expect(intersectsOffLimits(10, 20, spans)).toBe(true);
  });
  it('detects no overlap', () => {
    expect(intersectsOffLimits(0, 5, spans)).toBe(false);
    expect(intersectsOffLimits(20, 30, spans)).toBe(false);
    expect(intersectsOffLimits(40, 50, spans)).toBe(false);
  });
});

// ── mustKeep treasury ───────────────────────────────────────────────────────

describe('B1-1: mustKeep treasury', () => {
  it('finds numbers', () => {
    expect(mustKeepMatches('error code 404 at line 42')).toContain('404');
    expect(mustKeepMatches('error code 404 at line 42')).toContain('42');
  });
  it('finds URLs', () => {
    const matches = mustKeepMatches('see https://example.com/docs for details');
    expect(matches.some(m => m.includes('https://example.com'))).toBe(true);
  });
  it('finds file paths', () => {
    const matches = mustKeepMatches('edit /etc/hosts or /usr/local/bin/node');
    expect(matches.some(m => m.includes('/etc/hosts'))).toBe(true);
  });
  it('finds hex hashes', () => {
    const matches = mustKeepMatches('commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 done');
    expect(matches.some(m => m.length >= 32)).toBe(true);
  });
  it('finds ALLCAPS constants', () => {
    const matches = mustKeepMatches('set MAX_RETRIES to TIMEOUT_LIMIT');
    expect(matches).toContain('MAX_RETRIES');
  });
});

// ── Inflation guard ────────────────────────────────────────────────────────

describe('B1-1: compressStep inflation guard', () => {
  it('returns original when compressed is larger', () => {
    const original = 'short text';
    const compressed = 'longer compressed text that is bigger than the original';
    const result = compressStep(original, compressed);
    expect(result.applied).toBe(false);
    expect(result.out).toBe(original);
    expect(result.saved).toBe(0);
  });
  it('returns compressed when it is smaller', () => {
    const original = 'a very long piece of text that goes on and on and on';
    const compressed = 'short';
    const result = compressStep(original, compressed);
    expect(result.applied).toBe(true);
    expect(result.out).toBe(compressed);
    expect(result.saved).toBeGreaterThan(0);
  });
  it('returns original when compressed equals original size', () => {
    const original = 'exactly the same size text!';
    const compressed = 'also the same total size!';
    expect(countTokensEstimate(original)).toBe(countTokensEstimate(compressed));
    const result = compressStep(original, compressed);
    expect(result.applied).toBe(false);
    expect(result.out).toBe(original);
  });
});

// ── Fail-open exception guard ───────────────────────────────────────────────

describe('B1-1: compressSafely fail-open', () => {
  it('returns original when fn throws', () => {
    const original = 'original text';
    const result = compressSafely(original, () => { throw new Error('compressor exploded'); });
    expect(result).toBe(original);
  });
  it('returns fn result when fn succeeds', () => {
    const original = 'original text';
    const result = compressSafely(original, () => 'compressed');
    expect(result).toBe('compressed');
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe('B1-1: metrics', () => {
  it('emptyMetrics returns all zeros', () => {
    const m = emptyMetrics();
    expect(m.compressionApplied).toBe(0);
    expect(m.tokensBefore).toBe(0);
    expect(m.tokensAfter).toBe(0);
    expect(m.tokensSaved).toBe(0);
    expect(m.inflationsReverted).toBe(0);
    expect(m.failuresOpened).toBe(0);
  });

  it('recordStep tracks applied compression', () => {
    const m = emptyMetrics();
    const originalTokens = countTokensEstimate('a very long piece of text that goes on and on');
    const result = compressStep('a very long piece of text that goes on and on', 'short');
    recordStep(m, result, originalTokens);
    expect(m.compressionApplied).toBe(1);
    expect(m.tokensSaved).toBeGreaterThan(0);
  });

  it('recordStep tracks inflation reversion', () => {
    const m = emptyMetrics();
    const originalTokens = countTokensEstimate('short');
    const result = compressStep('short', 'longer compressed version that is bigger');
    recordStep(m, result, originalTokens);
    expect(m.inflationsReverted).toBe(1);
    expect(m.compressionApplied).toBe(0);
  });
});

// ── Config defaults ─────────────────────────────────────────────────────────

describe('B1-1: compression config defaults', () => {
  it('returns correct defaults when settings unset', () => {
    clearCompressionConfigCache();
    const cfg = getCompressionConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minTokens).toBe(250);
    expect(cfg.protectRecent).toBe(4);
    expect(cfg.smartCrusher).toBe(false);
    expect(cfg.toon).toBe(false);
    expect(cfg.emitSentinel).toBe(false); // B1-2 will add this setting
    expect(cfg.smartCrusherLosslessOnly).toBe(false); // B1-2 will add this setting
    expect(cfg.minSavingsRatio).toBe(0.15); // B1-2 will add this setting
  });
});
