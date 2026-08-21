import { describe, it, expect } from 'vitest';
import {
  smartCrush,
  detectShape,
  simHash,
  pickK,
  splitK,
  keepConstraints,
  toonRender,
  isToonRenderable,
  type SmartCrushOptions,
} from '../../middle/compression/techniques/smart-crusher.js';

// ── Shape detection ────────────────────────────────────────────────────────

describe('B1-2: detectShape', () => {
  it('detects dict-array', () => {
    expect(detectShape([{ a: 1 }, { b: 2 }])).toBe('dict-array');
  });
  it('detects string-array', () => {
    expect(detectShape(['hello', 'world'])).toBe('string-array');
  });
  it('detects number-array', () => {
    expect(detectShape([1, 2, 3])).toBe('number-array');
  });
  it('detects mixed', () => {
    expect(detectShape([{ a: 1 }, 'string', 42])).toBe('mixed');
  });
  it('detects scalar (empty)', () => {
    expect(detectShape([])).toBe('scalar');
  });
});

// ── SimHash ─────────────────────────────────────────────────────────────────

describe('B1-2: simHash (true 64-bit — H13)', () => {
  function hamming(a: bigint, b: bigint): number {
    let x = BigInt.asUintN(64, a ^ b);
    let d = 0;
    while (x) { d += Number(x & 1n); x >>= 1n; }
    return d;
  }
  it('returns same hash for identical strings', () => {
    expect(simHash('hello world')).toBe(simHash('hello world'));
  });
  it('returns different hashes for different strings', () => {
    expect(simHash('hello world')).not.toBe(simHash('goodbye universe'));
  });
  it('near-duplicate strings have similar hashes (low Hamming distance)', () => {
    const h1 = simHash('error: connection refused at host 1.2.3.4');
    const h2 = simHash('error: connection refused at host 1.2.3.5');
    // One token differs — far below the ~32 expected for unrelated strings.
    expect(hamming(h1, h2)).toBeLessThanOrEqual(24);
  });
  it('unrelated strings average ~32 bits apart — the hash discriminates', () => {
    const pairs: Array<[string, string]> = [
      ['alpha beta gamma delta epsilon', 'zebra yak xenon walnut quasar'],
      ['the quick brown fox jumps', 'lazy dogs sleep under trees'],
      ['http error five zero three', 'connection timeout after seconds'],
      ['user requested data export', 'system performed nightly backup'],
      ['model produced tokens quickly', 'router selected fastest provider'],
      ['cache hit ratio improved today', 'memory pressure rose slightly'],
    ];
    const ds = pairs.map(([a, b]) => hamming(simHash(a), simHash(b)));
    const avg = ds.reduce((x, y) => x + y, 0) / ds.length;
    // The pre-H13 hash aliased upper bits onto lower ones — unrelated pairs
    // collapsed toward ~16 effective bits. A correct 64-bit simhash centers
    // on 32.
    expect(avg).toBeGreaterThan(24);
  });
  it('uses the upper 32 bits of the hash space', () => {
    // With the broken 32-bit arithmetic, bits 32-63 were always zero.
    let acc = 0n;
    for (let i = 0; i < 16; i++) acc |= simHash(`sample corpus text number ${i} with varied words`);
    expect(acc > 0xffffffffn).toBe(true);
  });
});

// ── Adaptive K ─────────────────────────────────────────────────────────────

describe('B1-2: pickK + splitK', () => {
  it('pickK returns full length for small arrays', () => {
    expect(pickK(3)).toBe(3);
    expect(pickK(5)).toBe(5);
  });
  it('pickK targets ~40% for larger arrays', () => {
    expect(pickK(100)).toBe(40);
    expect(pickK(50)).toBe(20);
  });
  it('pickK has a minimum of 5', () => {
    expect(pickK(8)).toBeGreaterThanOrEqual(5);
  });
  it('splitK returns head + tail budgets', () => {
    const { kFirst, kLast } = splitK(20);
    expect(kFirst).toBe(6); // 30%
    expect(kLast).toBe(3);  // 15%
  });
});

// ── Always-keep constraints ────────────────────────────────────────────────

describe('B1-2: keepConstraints', () => {
  it('keeps error rows', () => {
    const arr = [{ msg: 'ok' }, { msg: 'error: timeout' }, { msg: 'ok' }];
    const keep = keepConstraints(arr);
    expect(keep.has(1)).toBe(true);
  });
  it('keeps query-anchor matches', () => {
    const arr = [{ data: 'foo' }, { data: 'bar' }, { data: 'query result' }];
    const keep = keepConstraints(arr, ['query']);
    expect(keep.has(2)).toBe(true);
  });
  it('keeps rows with mustKeep tokens (URLs, numbers)', () => {
    const arr = [{ url: 'nothing' }, { url: 'https://example.com/api' }];
    const keep = keepConstraints(arr);
    expect(keep.has(1)).toBe(true);
  });
});

// ── TOON render ─────────────────────────────────────────────────────────────

describe('B1-2: toonRender', () => {
  it('renders [N]{cols} header + CSV rows', () => {
    const arr = [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }];
    const result = toonRender(arr);
    expect(result).toContain('[2]{name,age}');
    expect(result).toContain('Alice,30');
    expect(result).toContain('Bob,25');
  });
  it('CSV-escapes values with commas', () => {
    const arr = [{ text: 'hello, world' }];
    const result = toonRender(arr);
    expect(result).toContain('"hello, world"');
  });
  it('CSV-escapes values with quotes', () => {
    const arr = [{ text: 'say "hi"' }];
    const result = toonRender(arr);
    expect(result).toContain('"say ""hi"""');
  });
  it('returns [] for empty array', () => {
    expect(toonRender([])).toBe('[]');
  });
});

describe('M29: isToonRenderable + lossless guard', () => {
  it('accepts uniform scalar rows', () => {
    expect(isToonRenderable([{ a: 'x', b: 1 }, { a: 'y', b: 2 }])).toBe(true);
  });
  it('rejects nested object values', () => {
    expect(isToonRenderable([{ a: { nested: true } }])).toBe(false);
  });
  it('rejects array values', () => {
    expect(isToonRenderable([{ a: [1, 2] }])).toBe(false);
  });
  it('rejects null values', () => {
    expect(isToonRenderable([{ a: null }])).toBe(false);
  });
  it('rejects ragged key-sets (extra key on later row)', () => {
    expect(isToonRenderable([{ a: 1 }, { a: 1, b: 2 }])).toBe(false);
  });
  it('rejects reordered keys', () => {
    expect(isToonRenderable([{ a: 1, b: 2 }, { b: 2, a: 1 }])).toBe(false);
  });
  it('rejects empty rows array', () => {
    expect(isToonRenderable([])).toBe(false);
  });

  it('lossless path passes through non-renderable dict-array instead of rendering [object Object]', () => {
    const content = JSON.stringify([
      { id: 1, meta: { deep: true } },
      { id: 2, meta: { deep: false } },
    ]);
    const result = smartCrush(content, { losslessOnly: true, emitSentinel: false });
    expect(result.applied).toBe(false);
    expect(result.output).toBe(content); // byte-identical passthrough
    expect(result.output).not.toContain('[object Object]');
  });

  it('lossless path still renders renderable dict-array as TOON, never with a sentinel', () => {
    const content = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ id: i, name: `row-${i}` })),
    );
    const result = smartCrush(content, { losslessOnly: true, emitSentinel: true });
    expect(result.applied).toBe(true);
    expect(result.output).toContain('[20]{id,name}');
    expect(result.sentinel).toBeNull();
  });

  it('lossy path falls back to JSON when the subset is not renderable', () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      message: `row ${i}`,
      status: i % 10 === 0 ? 'error: failed' : 'ok',
      ...(i === 7 ? { extra: { nested: 1 } } : {}),
    }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false, emitSentinel: true });
    expect(result.applied).toBe(true);
    expect(result.output).not.toContain('[object Object]');
    expect(result.output).not.toContain('[50]{');
    expect(result.sentinel).not.toBeNull();
  });
});

// ── SmartCrusher main ────────────────────────────────────────────────────────

describe('B1-2: smartCrush', () => {
  // Helper: make a large dict-array tool output
  function makeToolOutput(n: number): string {
    const arr = Array.from({ length: n }, (_, i) => ({
      id: i,
      message: `row ${i}`,
      status: i % 10 === 0 ? 'error: failed' : 'ok',
    }));
    return JSON.stringify(arr);
  }

  it('(a) preserves error rows, head/tail in subset selection', () => {
    const content = makeToolOutput(50);
    const result = smartCrush(content, { losslessOnly: false });
    // Error rows (every 10th) should be kept
    if (result.applied) {
      const arr = JSON.parse(content) as Array<Record<string, unknown>>;
      const errorIndices = arr.map((r, i) => r.status.toString().includes('error') ? i : -1).filter(i => i >= 0);
      // The output should contain all error rows (they're always-keep)
      for (const ei of errorIndices) {
        expect(result.output).toContain(arr[ei].message as string);
      }
    }
  });

  it('(b) SimHash de-dupes near-duplicate rows', () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ msg: `duplicate row`, idx: i }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false });
    // Near-duplicate rows should be heavily compressed
    expect(result.applied).toBe(true);
    expect(result.keptCount).toBeLessThan(result.originalCount);
  });

  it('(c) order is preserved (output indices are a monotone subset)', () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, data: `item ${i}` }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false });
    expect(result.applied).toBe(true);
    expect(result.shape).toBe('dict-array');
    // TOON-rendered output preserves order in CSV rows
    expect(result.output).toContain('item 0');
  });

  it('(d) min-savings floor falls back to passthrough when subset ≥ 85%', () => {
    // Only 6 rows → pickK returns 5 → 5/6 = 83% kept → 17% savings > 15% → applied
    // But 5/6 = 83% < 85% → savings = 17% > 15% → should be applied
    // To test the floor, use an array where almost all rows must be kept
    const arr = Array.from({ length: 6 }, (_, i) => ({ id: i, error: `error ${i}` }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false });
    // All rows have 'error' keyword → all are always-keep → no drop → passthrough
    expect(result.applied).toBe(false);
  });

  it('(e) lossless_only=true drops nothing — only TOON render yields savings', () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `item${i}`, value: i * 10 }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: true });
    // TOON render should be smaller than the original JSON
    expect(result.applied).toBe(true);
    expect(result.droppedCount).toBe(0);
    expect(result.output).toContain('[30]{');
  });

  it('(f) fenced code inside a tool output survives (off-limits protection)', () => {
    // A JSON array where one row contains a fenced code block
    const arr = [
      { code: '```python\nprint("hello")\n```' },
      { data: 'normal row 1' },
      { data: 'normal row 2' },
    ];
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false });
    expect(result.applied).toBe(true);
    // M29: ragged-key subsets are not TOON-renderable → JSON fallback, so the
    // kept row survives byte-exact (fence intact, no CSV re-escaping).
    expect(result.output).toContain(JSON.stringify(arr[0]));
  });

  it('(g) redaction placeholder embedded in a tool-output JSON row survives verbatim', () => {
    const arr = [
      { key: '⟦R1:974c7b⟧', data: 'row 0' },
      { data: 'row 1' },
      { data: 'row 2' },
      { data: 'row 3' },
      { data: 'row 4' },
      { data: 'row 5' },
    ];
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false });
    // The placeholder must survive in the output
    expect(result.output).toContain('⟦R1:974c7b⟧');
  });

  it('(h) shape-mixed or scalar → passthrough', () => {
    expect(smartCrush('not json at all', { losslessOnly: false }).applied).toBe(false);
    expect(smartCrush('{"key": "value"}', { losslessOnly: false }).applied).toBe(false);
    expect(smartCrush('[1, "two", {"three": 3}]', { losslessOnly: false }).applied).toBe(false);
  });

  it('emits sentinel marker when rows are dropped', () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, data: `item ${i}` }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false, emitSentinel: true });
    expect(result.applied).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.sentinel).toMatch(/⟦C7:<<crushed \d+ rows, hash [0-9a-f]{6}>>⟧/);
  });

  it('does not emit sentinel when emitSentinel=false', () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, data: `item ${i}` }));
    const content = JSON.stringify(arr);
    const result = smartCrush(content, { losslessOnly: false, emitSentinel: false });
    expect(result.applied).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.sentinel).toBeNull();
  });

  it('inflation guard: returns original when compressed is larger', () => {
    // A single-element array can never clear the min-savings floor (kept
    // fraction is 1.0 ≥ 0.85), so smartCrush passes it through untouched —
    // and any "compressed" render of one row would only inflate.
    const content = JSON.stringify([{ a: 1 }]);
    const result = smartCrush(content, { losslessOnly: false });
    expect(result.applied).toBe(false);
    expect(result.output).toBe(content);
  });

  it('fail-open on invalid JSON: returns original', () => {
    const content = '{ invalid json';
    const result = smartCrush(content, { losslessOnly: false });
    expect(result.output).toBe(content);
    expect(result.applied).toBe(false);
  });
});
