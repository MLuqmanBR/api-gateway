import { useId } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const FILTER_ALL_KEY = '__all__'

/**
 * Live filter input used by the Models pages.
 *
 * Search behaviour (per-product spec):
 *  - case-insensitive substring match
 *  - matches within displayName, modelId, AND platform
 *  - match can be at start, middle, or end — no anchors
 *
 * Cheap enough to run on every keystroke: the model arrays are bounded
 * (~750 entries today) and `filter` is O(n) over strings of <100 chars
 * each, so debouncing would add complexity without buying anything.
 */
export function ModelSearchBox({
  value,
  onChange,
  placeholder = 'Filter models…',
  showCount,
  total,
  matched,
  className,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  /** Optional "X of Y" count next to the input — hides when value is empty. */
  showCount?: boolean
  total?: number
  matched?: number
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('relative w-full sm:max-w-xs', className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        id={id}
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape' && value !== '') { e.preventDefault(); onChange('') } }}
        placeholder={placeholder}
        aria-label="Filter models"
        className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-8 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:border-ring transition-colors"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear filter"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {showCount && value !== '' && typeof total === 'number' && typeof matched === 'number' && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" aria-live="polite">
          Showing {matched} of {total}
        </p>
      )}
    </div>
  )
}

/**
 * Pure filter helper. Kept here so both models pages use the exact same
 * match rules — saves drift if the rules ever need to tighten (e.g. start
 * adding word-boundary scoring).
 */
export function matchesModelQuery(query: string, fields: { displayName: string; modelId: string; platform: string }): boolean {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return true
  return (
    fields.displayName.toLowerCase().includes(q)
    || fields.modelId.toLowerCase().includes(q)
    || fields.platform.toLowerCase().includes(q)
  )
}
