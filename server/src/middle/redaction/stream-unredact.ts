/**
 * Streaming un-redactor — Row B2-5.
 *
 * ThinkTagStream-shaped class that replaces complete placeholders with their
 * real values as they arrive in SSE chunks. Holds back the longest suffix
 * that could be a prefix of a placeholder so a placeholder split across chunk
 * boundaries is not partially emitted.
 *
 * Mangled variants are NOT handled in-stream (can't distinguish `[R7:` from
 * real prose mid-stream); they're handled at finalization sites only where
 * the complete string exists.
 *
 * Bounded hold-back: a placeholder is ≤16 chars, so the hold is capped at 16.
 * Never buffers unbounded content, never reorders, never touches non-placeholder
 * bytes.
 */

import { PLACEHOLDER_RE, couldBePlaceholderPrefix, PLACEHOLDER_OPEN } from './spans.js';

const MAX_HOLD = 16; // max placeholder length: ⟦R + digits + : + 12 hex + ⟧

export class StreamUnredactor {
  private buffer = '';
  private readonly map: ReadonlyMap<string, string>;

  constructor(map: ReadonlyMap<string, string>) {
    this.map = map;
  }

  /** Feed a chunk of text. Returns the safe-to-emit portion: all complete
   * placeholders replaced, with any potential partial-placeholder suffix
   * held back for the next feed or flush. */
  feed(chunk: string): string {
    if (chunk.length === 0) return '';
    // Empty map → zero-alteration pass-through (no hold-back, no buffering).
    if (this.map.size === 0) return chunk;
    this.buffer += chunk;
    return this.drain();
  }

  /** Call at end-of-stream. Emits any held residual verbatim — it's not a
   * complete placeholder, so it passes through as-is. */
  flush(): string {
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
  private drain(): string {
    // 1. Replace complete canonical placeholders in the buffer.
    let replaced = this.buffer;
    if (this.map.size > 0) {
      replaced = this.buffer.replace(PLACEHOLDER_RE, (match) => {
        const val = this.map.get(match);
        return val !== undefined ? val : match;
      });
    }

    // 2. Find the last ⟦ in the replaced buffer. If found, everything from
    //    there to the end could be a partial placeholder. Hold it back if
    //    the tail is within the MAX_HOLD limit and could be a placeholder prefix.
    //    This ensures we emit all text BEFORE the potential placeholder start,
    //    and only hold the partial placeholder itself.
    const lastOpen = replaced.lastIndexOf(PLACEHOLDER_OPEN);
    if (lastOpen >= 0 && replaced.length - lastOpen <= MAX_HOLD) {
      const tail = replaced.slice(lastOpen);
      if (couldBePlaceholderPrefix(tail)) {
        const emit = replaced.slice(0, lastOpen);
        this.buffer = tail;
        return emit;
      }
    }

    // No partial placeholder at the end — emit everything.
    this.buffer = '';
    return replaced;
  }
}
