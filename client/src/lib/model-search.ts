/**
 * Model-filter helpers shared across the Models pages.
 *
 * Kept in a plain module (not the component file) so the input component in
 * `components/model-search-box.tsx` can stay a component-only export for React
 * Fast Refresh.
 *
 * Search behaviour (per-product spec):
 *  - case-insensitive
 *  - matches within displayName, modelId, AND platform
 *  - match can be at start, middle, or end — no anchors
 *  - the query is normalized before matching: spaces, dashes, dots,
 *    underscores, slashes, colons all collapse to a single non-token so
 *    "kimi k2.6" and "kimi-k2-6" both hit the same id (see
 *    normalizeForSearch below). This is what makes typing
 *    `kimi k2.6` land on ids that contain `kimi-k2.6`.
 *  - multi-token AND: each whitespace-separated token must match
 *    somewhere across all fields; supports queries like "qwen 32b".
 *
 * Cheap enough to run on every keystroke: the model arrays are bounded
 * (~750 entries today) and `filter` is O(n) over strings of <100 chars
 * each, so debouncing would add complexity without buying anything.
 */
const TOKEN_CHARS_RE = /[\s._/:+-]+/g

/** Lowercase + collapse every "skip" character to a space, then re-trim. */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(TOKEN_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
}

export type SearchableModel = { displayName: string; modelId: string; platform: string }

/**
 * Pure filter helper. All callers go through this so the match rules stay
 * consistent across pages.
 */
export function matchesModelQuery(query: string, fields: SearchableModel): boolean {
  const q = normalizeForSearch(query)
  if (q.length === 0) return true
  // Build the haystack once per row. Single .toLowerCase() + normalize
  // pass per model — much cheaper than normalizing each field separately.
  const haystack = normalizeForSearch(
    `${fields.displayName} ${fields.modelId} ${fields.platform}`,
  )
  const tokens = q.split(' ')
  for (const token of tokens) {
    if (token.length === 0) continue
    if (!haystack.includes(token)) return false
  }
  return true
}
