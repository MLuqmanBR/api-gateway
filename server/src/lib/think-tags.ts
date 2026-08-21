// Pure `<think>` tag extractor for MiniMax reasoning content.
//
// Some providers (aggregatorc, openrouter, nvidia) return MiniMax M3 / M2.x
// reasoning inline in the `content` field wrapped in `<think>` tags, with no
// separate `reasoning_content` field. Both the streaming and non-streaming
// code paths in `routes/proxy.ts` use this module to split that into
// reasoning (goes to `reasoning_content`) and visible answer (stays in
// `content`).
//
// Rules (live-verified 2026-06-19):
//   1. Only the literal 7-char tag `<think>` is an opener. The word
//      "think" alone is never an opener.
//   2. Non-greedy: the first `</think>` after the opener wins, not the last.
//      Critical for the adversarial case where a code block contains
//      `r"<think>example</think>"` after the real think block.
//   3. Multiple sequential blocks are extracted in order; reasoning is
//      concatenated, visible preserves interleaving.
//   4. An opener with no `</think>` is treated as visible text. The literal
//      tag text is part of `visible`. Safe default: losing one block of
//      reasoning is much less bad than dropping the actual answer.
//      Streaming nuance: an unclosed opener is only held up to
//      THINK_UNCLOSED_HOLD_MAX — past the cap it is downgraded to prose
//      immediately (see L43 note at the constant).

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
// L43: an unclosed `<think>` used to buffer the ENTIRE remaining stream
// until a close tag or end-of-stream — unbounded memory and first-token
// latency when a model emits the tag inside ordinary prose and never closes
// it. Past this many held characters the opener is downgraded to prose:
// everything held is flushed as visible text and streaming resumes.
const THINK_UNCLOSED_HOLD_MAX = 64 * 1024;

/** Result of a full-text scan. Used by the non-streaming path and by tests. */
export interface ThinkTagResult {
  /** Concatenated content of every complete `<think>...</think>` block, in order. Empty when none. */
  reasoning: string;
  /** Content with every complete `<think>...</think>` block removed. */
  visible: string;
  /** True when at least one complete block was found. */
  extracted: boolean;
}

/**
 * Find every complete `<think>...</think>` block in `text` and split it into
 * (reasoning, visible). See file header for the rules.
 */
export function extractThinkTags(text: string): ThinkTagResult {
  if (text.length === 0) return { reasoning: '', visible: text, extracted: false };
  const reasoningParts: string[] = [];
  const visibleParts: string[] = [];
  let cursor = 0;
  let extracted = false;
  while (cursor < text.length) {
    const openIdx = text.indexOf(THINK_OPEN, cursor);
    if (openIdx < 0) {
      visibleParts.push(text.slice(cursor));
      break;
    }
    if (openIdx > cursor) visibleParts.push(text.slice(cursor, openIdx));
    const closeIdx = text.indexOf(THINK_CLOSE, openIdx + THINK_OPEN.length);
    if (closeIdx < 0) {
      // Unmatched opener: treat opener and everything after as visible.
      visibleParts.push(text.slice(openIdx));
      break;
    }
    reasoningParts.push(text.slice(openIdx + THINK_OPEN.length, closeIdx));
    cursor = closeIdx + THINK_CLOSE.length;
    extracted = true;
  }
  return {
    reasoning: reasoningParts.join(''),
    visible: visibleParts.join(''),
    extracted,
  };
}

/**
 * Stateful extractor for the streaming hold-window. One instance per
 * response. `feed(chunk)` accepts a piece of upstream text and returns
 * what can be safely emitted RIGHT NOW. `flush()` returns the final
 * residual (only the unclosed-opener-tail at end of stream) and the
 * accumulated reasoning.
 *
 * Each `feed` call returns only the reasoning extracted during that
 * call. The caller forwards each non-empty `reasoning` value as a
 * `reasoning_content` delta. `visible` is what should land in the
 * visible-content buffer (or be forwarded directly in passthrough).
 *
 * When a complete `<think>...</think>` block is consumed, the post-close text in the
 * same feed (or in subsequent feeds) is returned via `visible` on the
 * call that completes the close. `flush()` only returns the
 * unclosed-opener-tail as `residual` (the case where the stream ended
 * mid-think). This is the right rule for streaming: the visible text
 * streams out as soon as it is seen, not deferred to end-of-stream.
 */
export class ThinkTagStream {
  private buffer = '';
  private reasoningParts: string[] = [];

  feed(chunk: string): { visible: string; reasoning: string } {
    if (chunk.length === 0) return { visible: '', reasoning: '' };
    this.buffer += chunk;
    return this.drain();
  }

  /**
   * Call once at end-of-stream. Returns the unclosed-opener-tail as
   * `residual` (the caller appends it to the visible text — safe
   * default: treating unclosed as visible is the right policy because
   * losing one block of reasoning is much less bad than dropping the
   * actual answer). Returns the residual reasoning that was held in
   * the parts accumulator at the moment the stream ended (usually
   * empty because the last complete block was emitted on its feed).
   */
  flush(): { residual: string; reasoning: string } {
    return { residual: this.buffer, reasoning: this.reasoningParts.join('') };
  }

  private drain(): { visible: string; reasoning: string } {
    const visibleParts: string[] = [];
    let cursor = 0;
    let hadUnclosedOpener = false;
    while (cursor < this.buffer.length) {
      const openIdx = this.buffer.indexOf(THINK_OPEN, cursor);
      if (openIdx < 0) {
        // No complete opener. Before flushing the rest as visible, retain the
        // longest suffix of the buffer that is a proper prefix of THINK_OPEN,
        // so a `<think>` opener split across feeds (e.g. `...<thi` | `nk>...`)
        // isn't leaked as visible text. flush() emits a genuine trailing
        // partial opener at true end-of-stream.
        const len = this.buffer.length;
        let holdLen = 0;
        const maxHold = Math.min(THINK_OPEN.length - 1, len - cursor);
        for (let k = maxHold; k >= 1; k--) {
          if (this.buffer.startsWith(THINK_OPEN.slice(0, k), len - k)) {
            holdLen = k;
            break;
          }
        }
        visibleParts.push(this.buffer.slice(cursor, len - holdLen));
        if (holdLen > 0) {
          this.buffer = this.buffer.slice(len - holdLen);
          return { visible: visibleParts.join(''), reasoning: this.takeReasoning() };
        }
        cursor = len;
        break;
      }
      if (openIdx > cursor) visibleParts.push(this.buffer.slice(cursor, openIdx));
      const closeIdx = this.buffer.indexOf(THINK_CLOSE, openIdx + THINK_OPEN.length);
      if (closeIdx < 0) {
        if (this.buffer.length - cursor > THINK_UNCLOSED_HOLD_MAX) {
          // L43: hold cap exceeded — treat the opener as literal prose,
          // flush the held tail as visible, and keep streaming normally.
          visibleParts.push(this.buffer.slice(cursor));
          cursor = this.buffer.length;
          break;
        }
        // Opener present, no close yet — keep opener-tail in buffer for the
        // next feed. visibleParts already has the pre-open content.
        hadUnclosedOpener = true;
        cursor = openIdx;
        break;
      }
      this.reasoningParts.push(this.buffer.slice(openIdx + THINK_OPEN.length, closeIdx));
      cursor = closeIdx + THINK_CLOSE.length;
    }
    // If an unclosed opener is in flight, hold its tail. Otherwise
    // (everything was complete) clear the buffer; the visible text
    // beyond the last close has already been pushed to visibleParts.
    this.buffer = hadUnclosedOpener ? this.buffer.slice(cursor) : '';
    return { visible: visibleParts.join(''), reasoning: this.takeReasoning() };
  }

  private takeReasoning(): string {
    if (this.reasoningParts.length === 0) return '';
    const out = this.reasoningParts.join('');
    this.reasoningParts = [];
    return out;
  }
}
