import { useId } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Live filter input used by the Models pages. The matching helpers
 * (`normalizeForSearch` / `matchesModelQuery`) live in `@/lib/model-search`
 * so this file only exports a component (React Fast Refresh requirement).
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
    <div className={cn('w-full sm:max-w-xs', className)}>
      <div className="relative h-8">
        <Search
          className="pointer-events-none absolute left-2.5 top-0 bottom-0 m-auto size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          id={id}
          // type="text" (not "search") so the browser's UA styles don't grow
          // the line box while typing — that used to push the absolutely-
          // positioned icons down out of bounds.
          type="text"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && value !== '') { e.preventDefault(); onChange('') } }}
          placeholder={placeholder}
          aria-label="Filter models"
          // Hide the WebKit/Blink native clear-button — we render our own.
          className="peer h-8 w-full rounded-lg border border-input bg-background pl-8 pr-8 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:border-ring transition-colors [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
        />
        {value !== '' && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear filter"
            className="absolute right-2 top-0 bottom-0 m-auto inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {showCount && value !== '' && typeof total === 'number' && typeof matched === 'number' && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" aria-live="polite">
          Showing {matched} of {total}
        </p>
      )}
    </div>
  )
}
