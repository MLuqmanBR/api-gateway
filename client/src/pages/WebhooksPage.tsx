import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { addToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'

interface Webhook {
  id: number
  url: string
  secret: string
  events_filter: string
  enabled: number
  created_at: number
}

// Static hint only — the backend matches filters with comma-separated exact
// names or `prefix.*` wildcards; no enum dependency in either direction.
const FILTER_HINT = '* · request.* · routing.* · routing.model_switch · budget.warn · health.check.failed'

function WebhooksSection() {
  const qc = useQueryClient()
  const { data: webhooks = [], isLoading } = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: () => apiFetch('/api/webhooks'),
  })

  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [filter, setFilter] = useState('*')
  const [revealed, setRevealed] = useState<number | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['webhooks'] })

  const create = useMutation({
    mutationFn: () =>
      apiFetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret, events_filter: filter || '*' }),
      }),
    onSuccess: () => {
      setUrl(''); setSecret(''); setFilter('*')
      addToast({ kind: 'success', title: 'Webhook created' })
      invalidate()
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: 'Create failed', description: e.message }),
  })

  const toggle = useMutation({
    mutationFn: (w: Webhook) =>
      apiFetch(`/api/webhooks?id=${w.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: w.enabled !== 1 }),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => addToast({ kind: 'warning', title: 'Toggle failed', description: e.message }),
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/webhooks?id=${id}`, { method: 'DELETE' }),
    onSuccess: () => { addToast({ kind: 'success', title: 'Webhook deleted' }); invalidate() },
    onError: (e: Error) => addToast({ kind: 'warning', title: 'Delete failed', description: e.message }),
  })

  const test = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/webhooks/test?id=${id}`, { method: 'POST' }),
    onSuccess: () => addToast({ kind: 'success', title: 'Test event queued', description: 'A signed webhook.test delivery is on its way.' }),
    onError: (e: Error) => addToast({ kind: 'warning', title: 'Test failed', description: e.message }),
  })

  return (
    <section className="rounded-3xl border bg-card p-5">
      <h2 className="text-sm font-semibold mb-1">Webhooks</h2>
      <p className="text-xs text-muted-foreground mb-4">
        Get a signed HTTP POST for every matching gateway event. Deliveries retry up to 3 times and are
        signed with <code className="font-mono">X-API-Gateway-Signature: sha256=HMAC(secret, body)</code>.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); if (url.trim() && secret.trim()) create.mutate() }}
        className="grid gap-2 mb-4 md:grid-cols-[1fr_1fr_180px_auto]"
      >
        <div className="space-y-1.5">
          <Label className="text-xs">URL</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hook" className="text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Secret</Label>
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="signing secret" className="text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Events filter</Label>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="*" className="text-xs" />
        </div>
        <Button type="submit" size="sm" disabled={create.isPending || !url.trim() || !secret.trim()} className="self-end">
          {create.isPending ? 'Adding…' : 'Add webhook'}
        </Button>
      </form>
      <p className="text-[11px] text-muted-foreground -mt-3 mb-4 font-mono">Filters: {FILTER_HINT}</p>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : webhooks.length > 0 ? (
        <div className="space-y-2">
          {webhooks.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-xs">
              <code className="font-mono truncate flex-1" style={{ maxWidth: 320 }}>{w.url}</code>
              <button
                type="button"
                className="font-mono text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setRevealed(revealed === w.id ? null : w.id)}
                title="Reveal / hide secret"
              >
                {revealed === w.id ? w.secret : '••••••••'}
              </button>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{w.events_filter}</span>
              <span className="text-muted-foreground">
                {new Date(w.created_at).toLocaleDateString()}
              </span>
              <span className={w.enabled === 1 ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
                {w.enabled === 1 ? 'active' : 'disabled'}
              </span>
              <Button variant="ghost" size="sm" onClick={() => test.mutate(w.id)} disabled={test.isPending}>
                Send test event
              </Button>
              <Button variant="ghost" size="sm" onClick={() => toggle.mutate(w)}>
                {w.enabled === 1 ? 'Disable' : 'Enable'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate(w.id)}>
                Delete
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No webhooks yet. Add one above.</p>
      )}
    </section>
  )
}

export default function WebhooksPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Webhooks" description="Push signed gateway events to external HTTP endpoints." />
      <WebhooksSection />
    </div>
  )
}
