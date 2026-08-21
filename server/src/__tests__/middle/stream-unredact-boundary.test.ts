// M31 regression: the streaming un-redactor must hold back (and eventually
// resolve) a full-width 12-hex placeholder split across SSE chunk boundaries.
import { StreamUnredactor } from '../../middle/redaction/stream-unredact.js';

const TAG = 'a3b724f00d12'; // 12 hex — full C06 width
const PLACEHOLDER = `⟦R1:${TAG}⟧`;

describe('M31 — StreamUnredactor across chunk boundaries', () => {
  it('resolves a 12-hex placeholder split at every boundary offset', () => {
    for (let split = 1; split < PLACEHOLDER.length; split++) {
      const map = new Map([[PLACEHOLDER, 'SECRET-VALUE']]);
      const u = new StreamUnredactor(map);
      const text = `before ${PLACEHOLDER} after`;
      const a = u.feed(text.slice(0, split));
      const b = u.feed(text.slice(split));
      const out = a + b + u.flush();
      expect(out).toBe('before SECRET-VALUE after');
    }
  });

  it('never emits a partial placeholder fragment', () => {
    const map = new Map([[PLACEHOLDER, 'SECRET-VALUE']]);
    const u = new StreamUnredactor(map);
    const a = u.feed(`x ${PLACEHOLDER.slice(0, 10)}`); // partial: ⟦R1:a3b724f0
    expect(a).toBe('x ');
    const b = u.feed(PLACEHOLDER.slice(10));
    expect(a + b).toBe('x SECRET-VALUE');
  });

  it('passes unrelated ⟦ text through when no placeholder matches', () => {
    const u = new StreamUnredactor(new Map([[PLACEHOLDER, 'S']]));
    const out = u.feed('math ⟦ 1+1 ⟧ ok') + u.flush();
    expect(out).toBe('math ⟦ 1+1 ⟧ ok');
  });
});
