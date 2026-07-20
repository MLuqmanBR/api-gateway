import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { addToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Trash2, RotateCcw, DollarSign } from 'lucide-react'

interface Budget {
  id: number
  scope: 'client_key' | 'global'
  scope_id: string | null
  daily_limit_cents: number | null
  weekly_limit_cents: number | null
  monthly_limit_cents: number | null
  weekly_reset_day: number
  daily_used_cents: number
  weekly_used_cents: number
  monthly_used_cents: number
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function ProgressBar({ used, limit }: { used: number; limit: number | null }) {
  if (!limit) return <span className="text-muted-foreground text-sm">no limit</span>
  const pct = Math.min(100, (used / limit) * 100)
  const color = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {formatCents(used)} / {formatCents(limit)}
      </span>
    </div>
  )
}

export default function BudgetPage() {
  const queryClient = useQueryClient()
  const [scope, setScope] = useState<'client_key' | 'global'>('global')
  const [scopeId, setScopeId] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [weeklyLimit, setWeeklyLimit] = useState('')
  const [monthlyLimit, setMonthlyLimit] = useState('')

  const { data: budgets = [], isLoading } = useQuery<Budget[]>({
    queryKey: ['budgets'],
    queryFn: () => apiFetch<Budget[]>('/api/budgets'),
  })

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiFetch('/api/budgets', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      addToast({ kind: 'success', title: 'Budget saved', sticky: false })
      setDailyLimit('')
      setWeeklyLimit('')
      setMonthlyLimit('')
      setScopeId('')
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const deleteMutation = useMutation({
    mutationFn: (b: Budget) =>
      apiFetch(`/api/budgets?scope=${b.scope}${b.scope_id ? `&scope_id=${b.scope_id}` : ''}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      addToast({ kind: 'success', title: 'Budget deleted', sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const resetMutation = useMutation({
    mutationFn: (b: Budget) =>
      apiFetch(`/api/budgets/reset?scope=${b.scope}${b.scope_id ? `&scope_id=${b.scope_id}` : ''}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      addToast({ kind: 'success', title: 'Usage reset', sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    createMutation.mutate({
      scope,
      scope_id: scope === 'client_key' ? scopeId : null,
      daily_limit_cents: dailyLimit ? Math.round(parseFloat(dailyLimit) * 100) : null,
      weekly_limit_cents: weeklyLimit ? Math.round(parseFloat(weeklyLimit) * 100) : null,
      monthly_limit_cents: monthlyLimit ? Math.round(parseFloat(monthlyLimit) * 100) : null,
    })
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader title="Budgets" description="Set $-spend caps per client key or globally. Requests are rejected with HTTP 402 when a limit is exceeded." />

      <form onSubmit={handleSubmit} className="mb-8 rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-medium">New Budget</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="scope">Scope</Label>
            <Select value={scope} onValueChange={v => setScope((v ?? 'global') as 'client_key' | 'global')}>
              <SelectTrigger id="scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                <SelectItem value="client_key">Client Key</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scope === 'client_key' && (
            <div>
              <Label htmlFor="scopeId">Client Key ID</Label>
              <Input id="scopeId" value={scopeId} onChange={e => setScopeId(e.target.value)} placeholder="ck_..." />
            </div>
          )}
          <div>
            <Label htmlFor="daily">Daily Limit ($)</Label>
            <Input id="daily" type="number" step="0.01" min="0" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} placeholder="10.00" />
          </div>
          <div>
            <Label htmlFor="weekly">Weekly Limit ($)</Label>
            <Input id="weekly" type="number" step="0.01" min="0" value={weeklyLimit} onChange={e => setWeeklyLimit(e.target.value)} placeholder="50.00" />
          </div>
          <div>
            <Label htmlFor="monthly">Monthly Limit ($)</Label>
            <Input id="monthly" type="number" step="0.01" min="0" value={monthlyLimit} onChange={e => setMonthlyLimit(e.target.value)} placeholder="200.00" />
          </div>
        </div>
        <Button type="submit" className="mt-4" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Saving…' : 'Save Budget'}
        </Button>
      </form>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : budgets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <DollarSign className="mx-auto mb-2 size-8 text-muted-foreground" />
          <p className="text-muted-foreground">No budgets set. Without a budget, all requests are allowed.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className="p-3 text-left font-medium">Scope</th>
                <th className="p-3 text-left font-medium">ID</th>
                <th className="p-3 text-left font-medium">Daily</th>
                <th className="p-3 text-left font-medium">Weekly</th>
                <th className="p-3 text-left font-medium">Monthly</th>
                <th className="p-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="p-3">{b.scope}</td>
                  <td className="p-3 font-mono text-xs text-muted-foreground">{b.scope_id ?? '—'}</td>
                  <td className="p-3"><ProgressBar used={b.daily_used_cents} limit={b.daily_limit_cents} /></td>
                  <td className="p-3"><ProgressBar used={b.weekly_used_cents} limit={b.weekly_limit_cents} /></td>
                  <td className="p-3"><ProgressBar used={b.monthly_used_cents} limit={b.monthly_limit_cents} /></td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" title="Reset usage"
                        onClick={() => resetMutation.mutate(b)}
                        disabled={resetMutation.isPending}>
                        <RotateCcw className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Delete budget"
                        onClick={() => deleteMutation.mutate(b)}
                        disabled={deleteMutation.isPending}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
