import { describe, it, expect } from 'vitest';
import { StreamUnredactor } from '../../middle/redaction/stream-unredact.js';

const PLACEHOLDER = '⟦R1:abc123⟧';
const SECRET = 'my-secret-value';

function makeMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe('StreamUnredactor — basic', () => {
  it('emits text with no placeholders unchanged', () => {
    const un = new StreamUnredactor(makeMap([[PLACEHOLDER, SECRET]]));
    expect(un.feed('hello world')).toBe('hello world');
    expect(un.flush()).toBe('');
  });

  it('replaces a complete placeholder in one chunk', () => {
    const un = new StreamUnredactor(makeMap([[PLACEHOLDER, SECRET]]));
    expect(un.feed(`prefix ${PLACEHOLDER} suffix`)).toBe(`prefix ${SECRET} suffix`);
    expect(un.flush()).toBe('');
  });

  it('handles multiple placeholders in one chunk', () => {
    const map = makeMap([['⟦R1:aaa111⟧', 'VAL1'], ['⟦R1:bbb222⟧', 'VAL2']]);
    const un = new StreamUnredactor(map);
    expect(un.feed('⟦R1:aaa111⟧ and ⟦R1:bbb222⟧')).toBe('VAL1 and VAL2');
    expect(un.flush()).toBe('');
  });
});

describe('StreamUnredactor — split across chunks', () => {
  it('reassembles a placeholder split at every boundary position', () => {
    const full = `prefix ${PLACEHOLDER} suffix`;
    const map = makeMap([[PLACEHOLDER, SECRET]]);
    for (let split = 1; split < full.length; split++) {
      const part1 = full.slice(0, split);
      const part2 = full.slice(split);
      const un = new StreamUnredactor(map);
      const out1 = un.feed(part1);
      const out2 = un.feed(part2);
      const out3 = un.flush();
      const result = out1 + out2 + out3;
      expect(result).toBe(`prefix ${SECRET} suffix`);
    }
  });

  it('holds back partial placeholder at chunk boundary', () => {
    const un = new StreamUnredactor(makeMap([[PLACEHOLDER, SECRET]]));
    // Split in the middle of the placeholder
    const out1 = un.feed('prefix ⟦R1:ab');
    expect(out1).toBe('prefix '); // partial placeholder held back
    const out2 = un.feed('c123⟧ suffix');
    expect(out2).toBe(`${SECRET} suffix`);
    expect(un.flush()).toBe('');
  });

  it('holds back a lone trailing open bracket', () => {
    const un = new StreamUnredactor(makeMap([[PLACEHOLDER, SECRET]]));
    const out1 = un.feed('text with ⟦');
    expect(out1).toBe('text with '); // lone ⟦ held back
    const out2 = un.feed('R1:abc123⟧ done');
    expect(out2).toBe(`${SECRET} done`);
    expect(un.flush()).toBe('');
  });
});

describe('StreamUnredactor — non-placeholder content', () => {
  it('passes through non-placeholder ⟦ sequences after flush', () => {
    const un = new StreamUnredactor(makeMap([[PLACEHOLDER, SECRET]]));
    // ⟦ followed by non-placeholder text — the ⟦ is held, then the rest
    const out1 = un.feed('text ⟦ not a placeholder');
    // The ⟦ is 19 chars from the end — beyond the 16-char hold limit, so
    // it passes through immediately. Only the last 16 chars are checked.
    expect(out1).toBe('text ⟦ not a placeholder');
    expect(un.flush()).toBe('');
  });
});

describe('StreamUnredactor — interleaved placeholders', () => {
  it('handles multiple placeholders across chunks', () => {
    const map = makeMap([['⟦R1:aaa111⟧', 'V1'], ['⟦R1:bbb222⟧', 'V2']]);
    const un = new StreamUnredactor(map);
    expect(un.feed('start ⟦R1:aaa111⟧ mid ⟦R1:bbb')).toBe('start V1 mid ');
    expect(un.feed('222⟧ end')).toBe('V2 end');
    expect(un.flush()).toBe('');
  });
});

describe('StreamUnredactor — empty map (zero-alteration property)', () => {
  it('concatenation of feed+flush === input for various chunkings', () => {
    const un = new StreamUnredactor(new Map());
    const inputs = [
      ['hello', 'world'],
      ['a', 'b', 'c'],
      ['text with ⟦R1', ':abc123⟧', ' inside'],
      ['', 'empty first chunk'],
      ['single chunk'],
    ];
    for (const chunks of inputs) {
      const u = new StreamUnredactor(new Map());
      let out = '';
      for (const chunk of chunks) out += u.feed(chunk);
      out += u.flush();
      expect(out).toBe(chunks.join(''));
    }
  });
});

describe('StreamUnredactor — unknown placeholders', () => {
  it('passes through unknown placeholders unchanged', () => {
    const map = makeMap([['⟦R1:aaa111⟧', 'KNOWN']]);
    const un = new StreamUnredactor(map);
    // ⟦R1:bbb222⟧ is not in the map — passes through
    expect(un.feed('text ⟦R1:aaa111⟧ and ⟦R1:bbb222⟧')).toBe('text KNOWN and ⟦R1:bbb222⟧');
    expect(un.flush()).toBe('');
  });
});
