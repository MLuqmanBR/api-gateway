// The canonical effort scale, mirrored from server/src/lib/thinking.ts
// (THINKING_LEVELS). The client cannot import the server module, so the two
// must be kept in sync by hand — the server's zod enum validates every write,
// so drift here fails loudly at save time rather than silently.
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Force-disable switch, mirrored from the server's THINKING_OFF. Exclusive:
// stored/sent as ['off'] alone, never mixed with real levels.
export const THINKING_OFF = 'off'

/** Toggle a level inside a selection, refusing to empty it — the API requires
 *  at least one supported level (min(1)), so the last remaining level cannot
 *  be deselected. Selecting 'off' replaces the whole selection (exclusive);
 *  selecting any level clears 'off'. Returns the same array reference when
 *  nothing changes. */
export function toggleThinkingLevel(selected: string[], level: string): string[] {
  if (level === THINKING_OFF) {
    if (selected.length === 1 && selected[0] === THINKING_OFF) return selected
    return [THINKING_OFF]
  }
  const withoutOff = selected.filter(l => l !== THINKING_OFF)
  if (withoutOff.includes(level)) {
    if (withoutOff.length === 1) return withoutOff
    return withoutOff.filter(l => l !== level)
  }
  return [...withoutOff, level]
}
