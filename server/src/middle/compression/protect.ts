// B1-1: Off-limits guard — pure functions returning sorted [start,end) span
// lists of regions to PRESERVE byte-exact through any compression technique.
//
// Adapted from caveman-compress detect.py (verified WORKS, batch5) and
// headroom's _KOMPRESS_MUST_KEEP_RE (transforms/kompress_compressor.py).
// Concept port, original TS implementation.

// ── B2 redaction placeholder detector ────────────────────────────────────────
// Matches the canonical placeholder shape AND mangled variants (defense-in-depth
// even though role:"tool" is off-limits by default — see §0 invariant #6).
const PLACEHOLDER_RE = /⟦R\d+:[0-9a-f]{6,12}⟧/g;
const MANGLED_PLACEHOLDER_RE = /\[R\d+:[0-9a-f]{6,12}\]|⟦\s*R\d+:[0-9a-f]{6,12}\s*⟧|`⟦R\d+:[0-9a-f]{6,12}⟧`/g;

// ── Compression sentinel detector (B1-2) ─────────────────────────────────────
// C-prefixed variant of the B2 shape — same [N]:[hex] structure, different letter
// so un-redaction's tolerant regex doesn't accidentally substitute it.
const SENTINEL_RE = /⟦C\d+:<<[^>]+>>⟧/g;

// ── Fenced code block detector ───────────────────────────────────────────────
// Matches ```...``` blocks (including ~~~ fences and language-tagged opens).
const FENCED_CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2/g;

// ── Inline backtick detector ──────────────────────────────────────────────────
const INLINE_BACKTICK_RE = /`[^`\n]+`/g;

// ── JSON block detector ──────────────────────────────────────────────────────
// Matches strings that look like complete JSON objects or arrays.
const JSON_BLOCK_RE = /^\s*[\[{][\s\S]*[\]}]\s*$/;

// ── mustKeep treasury (headroom Kompress _KOMPRESS_MUST_KEEP_RE) ───────────────
// Numbers, ALLCAPS constants, URLs, file paths, hex hashes, and other tokens
// that a compressor must never drop. Techniques consult this via mustKeepMatches.
export const mustKeepRe =
  // Number tokens that carry meaning beyond a bare row index: decimals/versions,
  // and prefixed numeric codes (`error 404`, `code 42`, `# 7`), but NOT a bare
  // integer — every dataset row carries an id/index, so matching those marks
  // every row must-keep and kills the entire lossy drop path. (Also drops the
  // prior corrupted `ABCDEFGHIJKLMNOPQRSTUVWXYZ` alternative — a char class that
  // lost its brackets, matching only the literal text "ABCDEFGHIJKLMNOPQRSTUVWXYZ".)
  // Plus URLs, ABSOLUTE paths only (M42: the old `\/[^\s]+` matched any
  // slash-prefixed fragment — "and/or" kept "/or" alive), hex hashes, and
  // ALLCAPS constants.
  /(?:\b\d+\.\d+\b|\b(?:err(?:or)?|code|line|pg?|no\.?|#)\s*[-:]?\s*\d+\b)|https?:\/\/[^\s]+|(?<=^|[\s(])\/[^\s]+|\b[0-9a-f]{16,}\b|[A-Z][A-Z_]{2,}[A-Z0-9_]*\b/gi;

export type Span = { start: number; end: number };

/** Merge overlapping/adjacent spans into a sorted, non-overlapping list. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/** Collect all regex match spans from a text. */
function regexSpans(text: string, re: RegExp): Span[] {
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = globalRe.exec(text)) !== null) {
    if (m[0].length === 0) { globalRe.lastIndex++; continue; }
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** Detect all off-limits regions in a content string. Returns sorted [start,end) spans. */
export function detectOffLimits(text: string): Span[] {
  const spans: Span[] = [];
  // Fenced code blocks
  spans.push(...regexSpans(text, FENCED_CODE_RE));
  // Inline backticks
  spans.push(...regexSpans(text, INLINE_BACKTICK_RE));
  // B2 redaction placeholders (canonical + mangled)
  spans.push(...regexSpans(text, PLACEHOLDER_RE));
  spans.push(...regexSpans(text, MANGLED_PLACEHOLDER_RE));
  // Compression sentinels
  spans.push(...regexSpans(text, SENTINEL_RE));
  return mergeSpans(spans);
}

/** Whether a content string looks like a complete JSON object or array. */
export function isJsonBlock(text: string): boolean {
  return JSON_BLOCK_RE.test(text);
}

/** Whether a message role marks it as fully off-limits (role:"tool" is lossless by default). */
export function isOffLimitsRole(role: string): boolean {
  return role === 'tool';
}

/** Check whether a [start,end) range intersects any off-limits span. */
export function intersectsOffLimits(start: number, end: number, spans: Span[]): boolean {
  for (const s of spans) {
    if (start < s.end && end > s.start) return true;
  }
  return false;
}

/** Find all mustKeep tokens in a text (for techniques to respect). */
export function mustKeepMatches(text: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(mustKeepRe.source, 'g');
  while ((m = re.exec(text)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}
