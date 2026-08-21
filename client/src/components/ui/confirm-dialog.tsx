import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Button } from '@/components/ui/button'

/**
 * Destructive-action confirmation built on Base UI's AlertDialog primitive —
 * styled like the app's other modals. Lifted here from KeysPage once a second
 * page (FallbackPage) needed the same discard-confirmation pattern (audit N55).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  pending = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  pending?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border bg-card p-5 shadow-lg outline-none">
          <AlertDialog.Title className="text-sm font-medium">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Close render={<Button variant="ghost" size="sm">Cancel</Button>} />
            <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
              {pending ? 'Working…' : confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
