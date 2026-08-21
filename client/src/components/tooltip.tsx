import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Hover tooltip rendered through a portal to document.body, so it's never
// clipped by an ancestor's overflow (e.g. a table's overflow-x-auto). Position
// is computed from the trigger's rect and clamped to the viewport. `side`
// picks which edge it opens from (use 'bottom' under sticky headers).
export function Tooltip({ text, children, side = 'top', className }: {
  text: string
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)
  const id = useId()

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const half = 112 // half of the w-56 (224 px) tooltip
    const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    setCoords({ x, y: side === 'top' ? r.top : r.bottom })
  }, [side])

  function show() {
    setOpen(true)
    measure()
  }

  // Stay anchored while open: scrolling ANY container moves the trigger, and
  // scroll events don't bubble — hence capture. Resize changes the clamp too.
  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', measure, { capture: true })
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, { capture: true })
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])
  return (
    <span
      ref={ref}
      className={className ?? 'inline-flex'}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && coords && createPortal(
        <span
          id={id}
          role="tooltip"
          style={{
            position: 'fixed',
            left: coords.x,
            top: side === 'top' ? coords.y - 8 : coords.y + 8,
            transform: side === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
            zIndex: 9999,
          }}
          className="pointer-events-none w-56 rounded-lg bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background shadow-md"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
