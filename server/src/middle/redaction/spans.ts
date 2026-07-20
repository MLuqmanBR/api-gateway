/**
 * Redaction span engine — the deterministic core of the B2 redaction layer.
 *
 * No I/O, no DB, pure functions — fully unit-testable. Every other B2 row
 * builds on these primitives.
 *
 * Placeholder format: `⟦R<n>:<hex>⟧` (U+27E6/U+27E7 mathematical white square
 * brackets). These characters never occur organically in code/prose, survive
 * JSON.stringify unescaped (plain BMP chars), and are not split by common
 * tokenizers. See PRIVACY-LAYER-FABLE.md Row B2-1 for the full analysis.
 */

/** A detected secret occurrence in text with its replacement placeholder. */
export interface Span {
  start: number;
  end: number;
  value: string;
  placeholder: string;
}

/** A known secret with its pre-assigned placeholder. */
export interface KnownSecret {
  value: string;
  placeholder: string;
}

// --- Placeholder constants (folded here per Drift 5 — no separate file) ---

export const PLACEHOLDER_OPEN = '\u27E6'; // ⟦
export const PLACEHOLDER_CLOSE = '\u27E7'; // ⟧
export const PLACEHOLDER_PREFIX = `${PLACEHOLDER_OPEN}R`;

/**
 * Build a canonical placeholder string from a generation counter and hex tag.
 * The store (Row B2-2) calls this; the span engine itself receives
 * pre-assigned placeholders via `KnownSecret`.
 */
export function buildPlaceholder(generation: number, hexTag: string): string {
  return `${PLACEHOLDER_PREFIX}${generation}:${hexTag}${PLACEHOLDER_CLOSE}`;
}

/** Regex matching a complete canonical placeholder. Captures gen + hex. */
export const PLACEHOLDER_RE = /\u27E6R(\d+):([0-9a-f]{6,12})\u27E7/g;

/**
 * Check whether a string's suffix could be the start of a placeholder.
 * Used by the streaming un-redactor (Row B2-5) to decide how much to hold back.
 * Also holds a lone trailing `⟦` that might begin a placeholder.
 */
export function couldBePlaceholderPrefix(s: string): boolean {
  if (s.endsWith(PLACEHOLDER_OPEN)) return true;
  return /\u27E6R?\d*:?[0-9a-f]*$/.test(s);
}

// --- Span engine ---

/**
 * Find all non-overlapping occurrences of known secrets in text.
 * Overlap resolution: longest match first, then leftmost. No overlapping
 * output spans — once a span is claimed, shorter overlapping candidates are
 * dropped.
 */
export function findKnownSpans(text: string, secrets: ReadonlyArray<KnownSecret>): Span[] {
  if (secrets.length === 0 || text.length === 0) return [];

  const candidates: Span[] = [];
  for (const secret of secrets) {
    if (secret.value.length === 0) continue;
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(secret.value, from);
      if (idx === -1) break;
      candidates.push({
        start: idx,
        end: idx + secret.value.length,
        value: secret.value,
        placeholder: secret.placeholder,
      });
      from = idx + 1; // allow overlapping finds; resolution happens below
    }
  }

  if (candidates.length === 0) return [];

  // Sort: longest first (descending by length), then leftmost (ascending start).
  candidates.sort((a, b) => {
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenB !== lenA) return lenB - lenA; // longest first
    return a.start - b.start; // then leftmost
  });

  // Greedily pick non-overlapping spans.
  const picked: Span[] = [];
  const claimed: Array<{ start: number; end: number }> = [];
  for (const span of candidates) {
    const overlaps = claimed.some(c => span.start < c.end && span.end > c.start);
    if (!overlaps) {
      picked.push(span);
      claimed.push({ start: span.start, end: span.end });
    }
  }

  // Sort picked by start ascending for applySpans.
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

/**
 * Replace spans by slice-concatenation. NEVER regenerates text — walks the
 * original string once, copying unchanged regions and inserting placeholders
 * at span boundaries. Returns the redacted text and the spans actually applied.
 */
export function applySpans(text: string, spans: Span[]): { out: string; applied: Span[] } {
  if (spans.length === 0) return { out: text, applied: [] };

  // Defensive copy, sorted ascending by start.
  const sorted = [...spans].sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue; // skip overlapping (shouldn't happen post-resolution)
    parts.push(text.slice(cursor, span.start));
    parts.push(span.placeholder);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));

  return { out: parts.join(''), applied: sorted };
}

/**
 * Integrity check: rebuild the original from `out` by replacing each
 * placeholder back to its value, then compare byte-equal to `original`.
 * O(n), no LLM. Should always pass — if it fails, the caller falls back to
 * the original string (Row B2-3).
 */
export function verifyRedaction(original: string, out: string, applied: Span[]): boolean {
  if (applied.length === 0) return original === out;

  let rebuilt = out;
  // Replace placeholders back to values. Walk applied in reverse to avoid
  // index shifting (though since we use string replace, order doesn't matter
  // as long as placeholders are unique).
  for (const span of applied) {
    rebuilt = rebuilt.replace(span.placeholder, span.value);
  }
  return rebuilt === original;
}

/**
 * Inverse for complete strings (non-streaming): placeholder → value.
 * Uses a tolerant regex to catch canonical placeholders AND mangled variants
 * (square brackets, spaced, backtick-wrapped). Each mangled match is replaced
 * only if its tag uniquely identifies a span in the map; ambiguous or unknown
 * tags are left untouched (fail-safe: never substitute a guessed value).
 */
export function unredact(text: string, map: ReadonlyMap<string, string>): string {
  if (map.size === 0) return text;

  // 1. Canonical placeholders: ⟦R7:a3f2c9⟧
  let out = text.replace(PLACEHOLDER_RE, (match) => {
    const val = map.get(match);
    return val !== undefined ? val : match;
  });

  // 2. Mangled variants — each replaced only if the reconstructed canonical
  //    key uniquely identifies a map entry.
  // a. Square brackets: [R7:a3f2c9]
  out = out.replace(/\[R(\d+):([0-9a-f]{6,12})\]/g, (match, gen, hex) => {
    const canonical = buildPlaceholder(Number(gen), hex);
    const val = map.get(canonical);
    return val !== undefined ? val : match;
  });

  // b. Spaced: ⟦ R7:a3f2c9 ⟧
  out = out.replace(/\u27E6\s*R(\d+):([0-9a-f]{6,12})\s*\u27E7/g, (match, gen, hex) => {
    const canonical = buildPlaceholder(Number(gen), hex);
    const val = map.get(canonical);
    return val !== undefined ? val : match;
  });

  // c. Backtick-wrapped: `R7:a3f2c9` (without brackets — model dropped them)
  out = out.replace(/`R(\d+):([0-9a-f]{6,12})`/g, (match, gen, hex) => {
    const canonical = buildPlaceholder(Number(gen), hex);
    const val = map.get(canonical);
    return val !== undefined ? val : match;
  });

  return out;
}
