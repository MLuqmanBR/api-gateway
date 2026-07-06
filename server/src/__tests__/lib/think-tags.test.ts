import { describe, it, expect } from 'vitest';
import { extractThinkTags, ThinkTagStream } from '../../lib/think-tags.js';

const OPEN = '<think>';
const CLOSE = '</think>';

describe('extractThinkTags', () => {
  it('returns empty result for empty input', () => {
    const r = extractThinkTags('');
    expect(r).toEqual({ reasoning: '', visible: '', extracted: false });
  });

  it('passes through input without an opener', () => {
    const input = 'just a normal response with no tags';
    const r = extractThinkTags(input);
    expect(r.visible).toBe(input);
    expect(r.reasoning).toBe('');
    expect(r.extracted).toBe(false);
  });

  it('extracts a single block at the start of input', () => {
    const r = extractThinkTags(OPEN + 'r' + CLOSE + 'v');
    expect(r).toEqual({ reasoning: 'r', visible: 'v', extracted: true });
  });

  it('extracts a single block in the middle of input', () => {
    const r = extractThinkTags('pre' + OPEN + 'r' + CLOSE + 'post');
    expect(r).toEqual({ reasoning: 'r', visible: 'prepost', extracted: true });
  });

  it('extracts multiple sequential blocks and concatenates reasoning', () => {
    const r = extractThinkTags(OPEN + 'a' + CLOSE + 'x' + OPEN + 'b' + CLOSE + 'y');
    expect(r).toEqual({ reasoning: 'ab', visible: 'xy', extracted: true });
  });

  it('treats an unclosed opener as visible text', () => {
    const input = OPEN + 'r';
    const r = extractThinkTags(input);
    expect(r.reasoning).toBe('');
    expect(r.visible).toBe(input);
    expect(r.extracted).toBe(false);
  });

  // Adversarial: code block containing literal tags. The extractor
  // is text-only — it cannot tell that the second `` is inside
  // a string literal — so it extracts BOTH complete blocks. The
  // visible output is what is between the two blocks. This is
  // the documented limit of text-only extraction; the real model
  // response on this prompt is captured live 2026-06-19 from
  // aggregatorc/MiniMax-M3, and the visible residue is non-code-
  // (the answer body is the code block, the first block is the
  // reasoning about the user request). The integration relies on
  // a single think block per response, not on adversarial cases
  // where the model uses the literal tag twice in one response.
  it('extracts every complete block, even when code block contains literal tags', () => {
    const input =
      OPEN + 'real' + CLOSE +
      '\n\n```python\npattern = r"' + OPEN + 'example' + CLOSE + '"\n```';
    const r = extractThinkTags(input);
    expect(r.reasoning).toBe('realexample');
    expect(r.extracted).toBe(true);
    expect(r.visible).toBe('\n\n```python\npattern = r""\n```');
  });

  // Adversarial live test, captured 2026-06-19 from aggregatorc/MiniMax-M3
  // with prompt: "Write a Python function that adds two numbers. Include
  // a comment with the word think in it."
  it('preserves code block containing the word "think" as a comment', () => {
    const input = OPEN + 'meta' + CLOSE + '\n```python\n# think: simple\n```';
    const r = extractThinkTags(input);
    expect(r.reasoning).toBe('meta');
    expect(r.extracted).toBe(true);
    expect(r.visible).toContain('```python');
    expect(r.visible).toContain('# think: simple');
  });

  it('preserves markdown heading in the visible answer', () => {
    const input = OPEN + 'meta' + CLOSE + '\n# Step-by-Step\nbody';
    const r = extractThinkTags(input);
    expect(r.reasoning).toBe('meta');
    expect(r.extracted).toBe(true);
    expect(r.visible).toBe('\n# Step-by-Step\nbody');
  });
});

describe('ThinkTagStream', () => {
   it('returns the post-close text as visible when whole response fits in one feed', () => {
    const s = new ThinkTagStream();
    const out = s.feed(OPEN + 'r' + CLOSE + 'v');
    expect(out).toEqual({ visible: 'v', reasoning: 'r' });
    const f = s.flush();
    expect(f.residual).toBe('');
    expect(f.reasoning).toBe('');
  });

  it('handles the opener split across feeds', () => {
    const s = new ThinkTagStream();
    const first = s.feed(OPEN);
    expect(first).toEqual({ visible: '', reasoning: '' });
    const second = s.feed('r' + CLOSE + 'v');
    expect(second).toEqual({ visible: 'v', reasoning: 'r' });
    const f = s.flush();
    expect(f.residual).toBe('');
    expect(f.reasoning).toBe('');
  });

  it('handles the body split across feeds', () => {
    const s = new ThinkTagStream();
    const first = s.feed(OPEN + 'r');
    expect(first).toEqual({ visible: '', reasoning: '' });
    const second = s.feed(CLOSE + 'v');
    expect(second).toEqual({ visible: 'v', reasoning: 'r' });
    const f = s.flush();
    expect(f.residual).toBe('');
    expect(f.reasoning).toBe('');
  });

  it('emits pre-tag content as visible immediately', () => {
    const s = new ThinkTagStream();
    const first = s.feed('pre' + OPEN);
    expect(first).toEqual({ visible: 'pre', reasoning: '' });
    const second = s.feed('r' + CLOSE + 'v');
    expect(second).toEqual({ visible: 'v', reasoning: 'r' });
    const f = s.flush();
    expect(f.residual).toBe('');
    expect(f.reasoning).toBe('');
  });

  it('extracts multiple blocks across feeds in order', () => {
    const s = new ThinkTagStream();
    const first = s.feed(OPEN + 'a' + CLOSE);
    expect(first).toEqual({ visible: '', reasoning: 'a' });
    const second = s.feed('x' + OPEN + 'b' + CLOSE + 'y');
    expect(second).toEqual({ visible: 'xy', reasoning: 'b' });
    const f = s.flush();
    expect(f.residual).toBe('');
    expect(f.reasoning).toBe('');
  });

  it('returns the unclosed opener as residual at flush time', () => {
    const s = new ThinkTagStream();
    const first = s.feed(OPEN + 'r');
    expect(first).toEqual({ visible: '', reasoning: '' });
    const f = s.flush();
    expect(f.residual).toBe(OPEN + 'r');
    expect(f.reasoning).toBe('');
  });

  it('holds a partial opener split across feeds and does not leak it as visible', () => {
    const s = new ThinkTagStream();
    // delta1 ends mid-opener (`...<thi`), delta2 completes it.
    const first = s.feed('answer <thi');
    expect(first).toEqual({ visible: 'answer ', reasoning: '' });
    const second = s.feed('nk>secret reasoning</think>the real answer');
    expect(second).toEqual({ visible: 'the real answer', reasoning: 'secret reasoning' });
    const f = s.flush();
    expect(f.residual).toBe('');
    expect(f.reasoning).toBe('');
  });

  it('emits a genuine partial-opener tail as residual at flush when never completed', () => {
    const s = new ThinkTagStream();
    const first = s.feed('hello <thi');
    expect(first).toEqual({ visible: 'hello ', reasoning: '' });
    const f = s.flush();
    expect(f.residual).toBe('<thi');
    expect(f.reasoning).toBe('');
  });

  it('returns empty result for an empty feed', () => {
    const s = new ThinkTagStream();
    expect(s.feed('')).toEqual({ visible: '', reasoning: '' });
  });
});
