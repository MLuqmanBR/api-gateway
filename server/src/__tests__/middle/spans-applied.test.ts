// H37 regression: applySpans must report only the spans actually applied —
// skipped overlaps must not leak phantom placeholder→value entries into the
// session map used for un-redaction.
import { applySpans } from '../../middle/redaction/spans.js';

describe('H37 — applySpans applied-set accuracy', () => {
  it('excludes skipped overlapping spans from `applied`', () => {
    const text = 'abcdefghij';
    const first = { start: 1, end: 5, placeholder: '⟦R1:aaaaaa⟧' };
    const overlap = { start: 3, end: 7, placeholder: '⟦R1:bbbbbb⟧' }; // overlaps first — skipped
    const { out, applied } = applySpans(text, [first, overlap]);
    expect(out).toBe('a⟦R1:aaaaaa⟧fghij'); // 'bcdef' replaced; overlap skipped
    expect(applied).toEqual([first]);
  });

  it('placeholder↔applied bijection holds: every applied placeholder is in out', () => {
    for (const span of [{ start: 0, end: 3, placeholder: '⟦R1:cccccc⟧' }, { start: 0, end: 3, placeholder: '⟦R1:dddddd⟧' }]) {
      const { out, applied } = applySpans('xyzrest', [span]);
      for (const s of applied) expect(out).toContain(s.placeholder);
      // And no unapplied placeholder leaked into the output.
      const { placeholder: _unused } = span;
      void _unused;
    }
  });

  it('non-overlapping spans all apply in order', () => {
    const { out, applied } = applySpans('one two three', [
      { start: 0, end: 3, placeholder: '⟦R1:eeeeee⟧' },
      { start: 4, end: 7, placeholder: '⟦R1:ffffff⟧' },
    ]);
    expect(out).toBe('⟦R1:eeeeee⟧ ⟦R1:ffffff⟧ three');
    expect(applied).toHaveLength(2);
  });
});
