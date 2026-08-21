import { describe, it, expect } from 'vitest';
import {
  findKnownSpans,
  applySpans,
  verifyRedaction,
  unredact,
  buildPlaceholder,
  couldBePlaceholderPrefix,
  PLACEHOLDER_OPEN,
  PLACEHOLDER_CLOSE,
  type Span,
  type KnownSecret,
} from '../../middle/redaction/spans.js';

// --- helpers ---

function makeSecrets(entries: Array<[string, string]>): KnownSecret[] {
  return entries.map(([value, placeholder]) => ({ value, placeholder }));
}

// Seeded PRNG (mulberry32) for deterministic property tests.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rng: () => number, maxLen: number): string {
  const chars = 'ABCDEFGH abcdef 0123日本語🌌';
  const len = Math.floor(rng() * maxLen) + 1;
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * chars.length)];
  return s;
}

describe('findKnownSpans', () => {
  it('returns empty for no secrets', () => {
    expect(findKnownSpans('hello world', [])).toEqual([]);
  });

  it('finds a single secret occurrence', () => {
    const spans = findKnownSpans('my key is SECRET here', makeSecrets([['SECRET', '⟦R1:abc123⟧']]));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 10, end: 16, value: 'SECRET', placeholder: '⟦R1:abc123⟧' });
  });

  it('finds multiple occurrences of the same secret', () => {
    const spans = findKnownSpans('SECRET and SECRET again', makeSecrets([['SECRET', '⟦R1:abc123⟧']]));
    expect(spans).toHaveLength(2);
    expect(spans[0].start).toBe(0);
    expect(spans[1].start).toBe(11);
  });

  it('finds multiple different secrets', () => {
    const spans = findKnownSpans('KEY1 and KEY2', makeSecrets([
      ['KEY1', '⟦R1:aaa111⟧'],
      ['KEY2', '⟦R1:bbb222⟧'],
    ]));
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ value: 'KEY1' });
    expect(spans[1]).toMatchObject({ value: 'KEY2' });
  });

  it('resolves overlaps: longest first', () => {
    // 'SECRET_KEY' (10) overlaps 'SECRET' (6) and 'KEY' (3)
    const spans = findKnownSpans('the SECRET_KEY here', makeSecrets([
      ['SECRET', '⟦R1:aaa111⟧'],
      ['SECRET_KEY', '⟦R1:bbb222⟧'],
      ['KEY', '⟦R1:ccc333⟧'],
    ]));
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe('SECRET_KEY'); // longest wins
  });

  it('resolves overlaps: leftmost when equal length', () => {
    // Both 'ABC' at position 0, overlapping at position 1
    // 'ABC' at 0-3, 'BCD' at 1-4 — same length, leftmost wins
    const spans = findKnownSpans('ABCD', makeSecrets([
      ['BCD', '⟦R1:bbb222⟧'],
      ['ABC', '⟦R1:aaa111⟧'],
    ]));
    expect(spans).toHaveLength(1);
    expect(spans[0].value).toBe('ABC'); // leftmost
  });
});

describe('applySpans', () => {
  it('returns text unchanged for no spans', () => {
    const result = applySpans('hello', []);
    expect(result.out).toBe('hello');
    expect(result.applied).toEqual([]);
  });
  it('replaces a single span', () => {
    // 'my SECRET here' → S at index 3, T at index 8, end=9
    const spans: Span[] = [{ start: 3, end: 9, value: 'SECRET', placeholder: '⟦R1:abc123⟧' }];
    const result = applySpans('my SECRET here', spans);
    expect(result.out).toBe('my ⟦R1:abc123⟧ here');
  });

  it('replaces multiple non-overlapping spans', () => {
    // 'KEY1 and KEY2' → KEY1 at 0-4, KEY2 at 9-13
    const spans: Span[] = [
      { start: 0, end: 4, value: 'KEY1', placeholder: '⟦R1:aaa111⟧' },
      { start: 9, end: 13, value: 'KEY2', placeholder: '⟦R1:bbb222⟧' },
    ];
    const result = applySpans('KEY1 and KEY2', spans);
    expect(result.out).toBe('⟦R1:aaa111⟧ and ⟦R1:bbb222⟧');
  });

  it('handles spans at string boundaries', () => {
    const spans: Span[] = [
      { start: 0, end: 3, value: 'ABC', placeholder: '⟦R1:a1b2c3d4e5f6⟧' },
      { start: 5, end: 8, value: 'XYZ', placeholder: '⟦R1:f6e5d4c3b2a1⟧' },
    ];
    const result = applySpans('ABCtoXYZ', spans);
    expect(result.out).toBe('⟦R1:a1b2c3d4e5f6⟧to⟦R1:f6e5d4c3b2a1⟧');
  });

  it('handles unicode/CJK content straddling span edges', () => {
    // 🌌 is 2 UTF-16 code units; CJK chars are 1 each
    const text = '前🌌后SECRET端';
    const spans: Span[] = [{ start: 4, end: 10, value: 'SECRET', placeholder: '⟦R1:abc123⟧' }];
    const result = applySpans(text, spans);
    expect(result.out).toBe('前🌌后⟦R1:abc123⟧端');
  });
});

describe('verifyRedaction', () => {
  it('returns true for identical strings with no spans', () => {
    expect(verifyRedaction('hello', 'hello', [])).toBe(true);
  });

  it('returns true after a valid redaction', () => {
    const text = 'my SECRET here';
    const spans = findKnownSpans(text, makeSecrets([['SECRET', '⟦R1:abc123⟧']]));
    const { out, applied } = applySpans(text, spans);
    expect(verifyRedaction(text, out, applied)).toBe(true);
  });

  it('returns false for mismatched original', () => {
    const spans: Span[] = [{ start: 0, end: 3, value: 'ABC', placeholder: '⟦R1:abc⟧' }];
    expect(verifyRedaction('XYZ', '⟦R1:abc⟧', spans)).toBe(false);
  });
});

describe('unredact', () => {
  it('returns text unchanged for empty map', () => {
    expect(unredact('hello ⟦R1:abc123⟧ world', new Map())).toBe('hello ⟦R1:abc123⟧ world');
  });

  it('replaces canonical placeholders', () => {
    const map = new Map([['⟦R1:abc123⟧', 'SECRET']]);
    expect(unredact('hello ⟦R1:abc123⟧ world', map)).toBe('hello SECRET world');
  });

  it('replaces multiple different placeholders', () => {
    const map = new Map([['⟦R1:aaa111⟧', 'KEY1'], ['⟦R1:bbb222⟧', 'KEY2']]);
    expect(unredact('⟦R1:aaa111⟧ and ⟦R1:bbb222⟧', map)).toBe('KEY1 and KEY2');
  });

  it('leaves unknown placeholders untouched (fail-safe)', () => {
    const map = new Map([['⟦R1:aaa111⟧', 'KEY1']]);
    expect(unredact('⟦R1:aaa111⟧ and ⟦R1:zzz999⟧', map)).toBe('KEY1 and ⟦R1:zzz999⟧');
  });

  it('replaces mangled square-bracket variants', () => {
    const map = new Map([['⟦R1:abc123⟧', 'SECRET']]);
    expect(unredact('hello [R1:abc123] world', map)).toBe('hello SECRET world');
  });

  it('replaces mangled spaced variants', () => {
    const map = new Map([['⟦R1:abc123⟧', 'SECRET']]);
    expect(unredact('hello ⟦ R1:abc123 ⟧ world', map)).toBe('hello SECRET world');
  });

  it('replaces mangled backtick-wrapped variants', () => {
    const map = new Map([['⟦R1:abc123⟧', 'SECRET']]);
    expect(unredact('hello `R1:abc123` world', map)).toBe('hello SECRET world');
  });

  it('leaves unknown mangled tags untouched', () => {
    const map = new Map([['⟦R1:abc123⟧', 'SECRET']]);
    expect(unredact('hello [R2:xyz999] world', map)).toBe('hello [R2:xyz999] world');
  });
});

describe('round-trip property: unredact(applySpans(x).out) === x', () => {
  it('round-trips for various inputs', () => {
    const secrets = makeSecrets([
      ['SECRET', '⟦R1:abc123⟧'],
      ['KEY', '⟦R1:def456⟧'],
      ['data', '⟦R1:7890ab⟧'],
    ]);
    const map = new Map(secrets.map(s => [s.placeholder, s.value]));

    const texts = [
      'no secrets here',
      'the SECRET is KEY to data',
      'SECRETKEY and KEYSECRET',
      'SECRET SECRET SECRET',
      'emoji 🌌 and SECRET',
      'CJK 漢字 with KEY',
      'empty',
      'SECRET',
    ];
    for (const text of texts) {
      const spans = findKnownSpans(text, secrets);
      const { out } = applySpans(text, spans);
      const restored = unredact(out, map);
      expect(restored).toBe(text);
    }
  });
});

describe('byte-identity outside spans (property test)', () => {
  it('preserves text outside spans for 1000 random cases', () => {
    const rng = mulberry32(42);
    const secrets = makeSecrets([
      ['sekrit', '⟦R1:abc123⟧'],
      ['tok', '⟦R1:def456⟧'],
      ['🔑', '⟦R1:789abc⟧'],
    ]);

    for (let i = 0; i < 1000; i++) {
      const text = randomString(rng, 30);
      // Inject a secret at a random position
      const secret = secrets[Math.floor(rng() * secrets.length)];
      const pos = Math.floor(rng() * (text.length + 1));
      const injected = text.slice(0, pos) + secret.value + text.slice(pos);

      const spans = findKnownSpans(injected, secrets);
      if (spans.length === 0) continue; // injected value might not be found if overlapping weird unicode

      const { out, applied } = applySpans(injected, spans);

      // Byte-identity: verify redaction is correct
      expect(verifyRedaction(injected, out, applied)).toBe(true);
    }
  });
});

describe('repeated secret → same placeholder', () => {
  it('uses the same placeholder for the same secret value', () => {
    const secrets = makeSecrets([['DUPLICATE', '⟦R1:abc123⟧']]);
    const spans = findKnownSpans('DUPLICATE and DUPLICATE', secrets);
    expect(spans).toHaveLength(2);
    expect(spans[0].placeholder).toBe(spans[1].placeholder);
  });
});

describe('placeholder-in-input protection', () => {
  it('does not redact a pre-existing placeholder-like string as a secret', () => {
    // If the text already contains ⟦R1:abc123⟧ and the secret value is
    // "⟦R1:abc123⟧", the span engine finds it as a literal occurrence —
    // but that's fine: the redaction replaces it with the same placeholder.
    // The real protection (never generate a colliding placeholder) is in
    // the store (Row B2-2), not here. Here we just verify the engine doesn't
    // break on pre-existing ⟦ chars.
    const text = 'existing ⟦R1:abc123⟧ in text';
    const secrets = makeSecrets([['SECRET', '⟦R1:abc123⟧']]);
    const spans = findKnownSpans(text, secrets);
    expect(spans).toHaveLength(0); // SECRET not in text
    const { out } = applySpans(text, spans);
    expect(out).toBe(text); // unchanged
  });
});

describe('buildPlaceholder', () => {
  it('builds a canonical placeholder', () => {
    expect(buildPlaceholder(1, 'abc123')).toBe('⟦R1:abc123⟧');
    expect(buildPlaceholder(42, 'deadbeef')).toBe('⟦R42:deadbeef⟧');
  });
});

describe('couldBePlaceholderPrefix', () => {
  it('returns true for a lone trailing open bracket', () => {
    expect(couldBePlaceholderPrefix('hello ⟦')).toBe(true);
  });

  it('returns true for a partial placeholder prefix', () => {
    expect(couldBePlaceholderPrefix('hello ⟦R')).toBe(true);
    expect(couldBePlaceholderPrefix('hello ⟦R1')).toBe(true);
    expect(couldBePlaceholderPrefix('hello ⟦R1:')).toBe(true);
    expect(couldBePlaceholderPrefix('hello ⟦R1:abc')).toBe(true);
    expect(couldBePlaceholderPrefix('hello ⟦R1:abc123')).toBe(true);
  });

  it('returns false for complete non-placeholder text', () => {
    expect(couldBePlaceholderPrefix('hello world')).toBe(false);
    expect(couldBePlaceholderPrefix('hello ⟧')).toBe(false);
  });
});

describe('unicode straddle', () => {
  it('correctly handles emoji at span boundaries', () => {
    // 🌌 is a surrogate pair (2 UTF-16 code units). Place a secret right
    // after it to verify indices are consistent.
    const text = '🌌KEY';
    const secrets = makeSecrets([['KEY', '⟦R1:abc123⟧']]);
    const spans = findKnownSpans(text, secrets);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(2); // after the surrogate pair
    expect(spans[0].end).toBe(5);
    const { out } = applySpans(text, spans);
    expect(out).toBe('🌌⟦R1:abc123⟧');
  });
});
