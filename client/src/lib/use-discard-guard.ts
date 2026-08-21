import { useCallback, useEffect, useState } from 'react'

/**
 * Close-guard for form modals (audit N55): Escape and backdrop clicks route
 * through `requestClose()`. When the modal holds typed input (`dirty`), the
 * close is deferred behind a discard confirmation instead of silently throwing
 * that input away; a pristine modal closes immediately. While the confirmation
 * dialog itself is open its own Escape handling applies, so the window
 * listener stands down.
 *
 * Pair with `<ConfirmDialog>`: render it with `open={confirming}`,
 * `onOpenChange={o => !o && setConfirming(false)}` and `onConfirm={onClose}`.
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void) {
  const [confirming, setConfirming] = useState(false)

  // Re-created when dirty or onClose changes; the Escape effect below
  // resubscribes with it. Callers pass inline arrows, so this fires per
  // render — an add/remove of one window listener, which is cheap.
  const requestClose = useCallback(() => {
    if (!dirty) onClose()
    else setConfirming(true)
  }, [dirty, onClose])

  useEffect(() => {
    if (confirming) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      }
    }
    // Capture phase so the guard wins over any page-level Escape handling.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirming, requestClose])

  return { confirming, setConfirming, requestClose }
}
