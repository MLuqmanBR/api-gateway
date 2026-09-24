// Inline reasoning-tag extractor.
//
// Some upstreams return chain-of-thought inline in the `content` field wrapped
// in an XML-ish tag pair, with no separate `reasoning_content` field. Both the
// streaming and non-streaming code paths in `routes/proxy.ts` (and the
// `/v1/responses` shim) use this module to split that into reasoning (goes to
// `reasoning_content`) and visible answer (stays in `content`).
//
// Rules:
//   1. Two literal opener/closer pairs are recognized, as COMPLETE PAIRS only:
//      the long form and the short form listed in THINK_TAGS. The word "think"
//      alone is never an opener. Case-sensitive, exact match: no attribute-
//      bearing, uppercase, or `reasoning`-named variants.
//   2. Non-greedy: the first matching closer after the opener wins, not the
//      last. Critical for the adversarial case where a code block contains a
//      literal tag pair after the real reasoning block.
//   3. Multiple sequential blocks are extracted in order; reasoning is
//      concatenated, visible preserves interleaving.
//   4. An opener with no matching closer — including one whose pair crosses
//      families — is treated as visible text. The literal tag text is part of
//      `visible`. Safe default: losing one block of reasoning is much less bad
//      than dropping the actual answer.
//      Streaming nuance: an unclosed opener is only held up to
//      THINK_UNCLOSED_HOLD_MAX — past the cap it is downgraded to prose
//      immediately (see L43 note at the constant).
//   5. Extraction is MODEL-AGNOSTIC: it must never depend on the model id.
//      Any model, including one added later, may inline a reasoning block, and
//      a model-id heuristic cannot know that in advance.

interface ThinkTag {
  open: string;
  close: string;
}

// Ordered LONGEST OPENER FIRST: when two openers match at the same offset the
// earlier entry wins, so a shorter opener can never shadow a longer one that
// starts with it. Both families are complete pairs; never pair an opener with
// the other family's closer.
const THINK_TAGS: readonly ThinkTag[] = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' },
];
const MAX_OPENER_LEN = THINK_TAGS.reduce((n, t) => Math.max(n, t.open.length), 0);

// L43: an unclosed opener used to buffer the ENTIRE remaining stream until a
// close tag or end-of-stream — unbounded memory and first-token latency when a
// model emits the tag inside ordinary prose and never closes it. Past this many
// held characters the opener is downgraded to prose: everything held is flushed
// as visible text and streaming resumes.
const THINK_UNCLOSED_HOLD_MAX = 64 * 1024;

/**
 * Earliest opener at or after `from`. Longest-opener-first table order breaks
 * offset ties, so an opener that is a prefix of another can never win.
 */
function findOpener(text: string, from: number): { index: number; tag: ThinkTag } | null {
  let best: { index: number; tag: ThinkTag } | null = null;
  for (const tag of THINK_TAGS) {
    const idx = text.indexOf(tag.open, from);
    if (idx < 0) continue;
    if (best === null || idx < best.index) best = { index: idx, tag };
  }
  return best;
}

/** Result of a full-text scan. Used by the non-streaming path and by tests. */
export interface ThinkTagResult {
  /** Concatenated content of every complete reasoning block, in order. Empty when none. */
  reasoning: string;
  /** Content with every complete reasoning block removed. */
  visible: string;
  /** True when at least one complete block was found. */
  extracted: boolean;
}

/**
 * Find every complete reasoning block in `text` and split it into
 * (reasoning, visible). See file header for the rules.
 */
export function extractThinkTags(text: string): ThinkTagResult {
  if (text.length === 0) return { reasoning: '', visible: text, extracted: false };
  const reasoningParts: string[] = [];
  const visibleParts: string[] = [];
  let cursor = 0;
  let extracted = false;
  while (cursor < text.length) {
    const found = findOpener(text, cursor);
    if (found === null) {
      visibleParts.push(text.slice(cursor));
      break;
    }
    if (found.index > cursor) visibleParts.push(text.slice(cursor, found.index));
    const closeIdx = text.indexOf(found.tag.close, found.index + found.tag.open.length);
    if (closeIdx < 0) {
      // Unmatched opener: treat opener and everything after as visible.
      visibleParts.push(text.slice(found.index));
      break;
    }
    reasoningParts.push(text.slice(found.index + found.tag.open.length, closeIdx));
    cursor = closeIdx + found.tag.close.length;
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
 * When a complete block is consumed, the post-close text in the same feed
 * (or in subsequent feeds) is returned via `visible` on the call that
 * completes the close. `flush()` only returns the unclosed-opener-tail as
 * `residual` (the case where the stream ended mid-reasoning). This is the
 * right rule for streaming: the visible text streams out as soon as it is
 * seen, not deferred to end-of-stream.
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
      const found = findOpener(this.buffer, cursor);
      if (found === null) {
        // No opener. Before flushing the rest as visible, retain the longest
        // suffix of the buffer that is a proper prefix of ANY opener, so an
        // opener split across feeds (e.g. `...<thi` | `nking>...`) isn't
        // leaked as visible text. flush() emits a genuine trailing partial
        // opener at true end-of-stream.
        const len = this.buffer.length;
        let holdLen = 0;
        const maxHold = Math.min(MAX_OPENER_LEN - 1, len - cursor);
        for (let k = maxHold; k >= 1; k--) {
          const tail = this.buffer.slice(len - k);
          if (THINK_TAGS.some((t) => t.open.startsWith(tail))) {
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
      if (found.index > cursor) visibleParts.push(this.buffer.slice(cursor, found.index));
      const closeIdx = this.buffer.indexOf(found.tag.close, found.index + found.tag.open.length);
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
        cursor = found.index;
        break;
      }
      this.reasoningParts.push(this.buffer.slice(found.index + found.tag.open.length, closeIdx));
      cursor = closeIdx + found.tag.close.length;
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