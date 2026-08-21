import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { addToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { Trash2, RotateCcw, DollarSign } from 'lucide-react'

interface Budget {
  id: number
  scope: 'client_key' | 'global'
  scope_id: string | null
  daily_limit_cents: number | null
  weekly_limit_cents: number | null
  monthly_limit_cents: number | null
  daily_used_cents: number
  weekly_used_cents: number
  monthly_used_cents: number
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function ProgressBar({ used, limit }: { used: number; limit: number | null }) {
  if (!limit) return <span className="text-xs text-muted-foreground">no limit</span>
  const pct = Math.min(100, (used / limit) * 100)
  const color = pct >= 90 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
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

  const hasLimits = !!(dailyLimit || weeklyLimit || monthlyLimit)
  const canSave = hasLimits && (scope === 'client_key' ? !!scopeId : true)

  // Single save path shared by the form submit and the floating-bar button.
  function saveBudget(e?: React.SyntheticEvent) {
    e?.preventDefault()
    if (!canSave) return
    createMutation.mutate({
      scope,
      scope_id: scope === 'client_key' ? scopeId : null,
      daily_limit_cents: dailyLimit ? Math.round(parseFloat(dailyLimit) * 100) : null,
      weekly_limit_cents: weeklyLimit ? Math.round(parseFloat(weeklyLimit) * 100) : null,
      monthly_limit_cents: monthlyLimit ? Math.round(parseFloat(monthlyLimit) * 100) : null,
    })
  }

  function handleDiscard() {
    setScope('global')
    setScopeId('')
    setDailyLimit('')
    setWeeklyLimit('')
    setMonthlyLimit('')
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Budgets" description="Set $-spend caps per client key or globally. Requests are rejected with HTTP 402 when a limit is exceeded." />

      <Card>
        <CardHeader>
          <CardTitle>New budget</CardTitle>
          <CardDescription>Create a spending cap. Global budgets apply to all requests; client-key budgets apply to a specific API key.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveBudget} className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Scope</Label>
                <Select value={scope} onValueChange={v => setScope((v ?? 'global') as 'client_key' | 'global')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="client_key">Client key</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {scope === 'client_key' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Client key ID</Label>
                  <Input value={scopeId} onChange={e => setScopeId(e.target.value)} placeholder="ck_..." className="font-mono text-xs" />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Daily limit ($)</Label>
                <Input type="number" step="0.01" min="0" value={dailyLimit} onChange={e => setDailyLimit(e.target.value)} placeholder="10.00" className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Weekly limit ($)</Label>
                <Input type="number" step="0.01" min="0" value={weeklyLimit} onChange={e => setWeeklyLimit(e.target.value)} placeholder="50.00" className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Monthly limit ($)</Label>
                <Input type="number" step="0.01" min="0" value={monthlyLimit} onChange={e => setMonthlyLimit(e.target.value)} placeholder="200.00" className="font-mono text-xs" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSave || createMutation.isPending}>
                {createMutation.isPending ? 'Saving…' : 'Save budget'}
              </Button>
              {!hasLimits && (
                <span className="text-xs text-muted-foreground">Enter at least one limit (daily, weekly or monthly).</span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : budgets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <DollarSign className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No budgets set. Without a budget, all requests are allowed.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Active budgets</CardTitle>
            <CardDescription>Spending caps and current usage. Requests exceeding a limit are rejected with HTTP 402.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {budgets.map((b) => (
              <div key={b.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium ${b.scope === 'global' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}>
                      {b.scope}
                    </span>
                    {b.scope_id && <code className="text-xs font-mono text-muted-foreground">{b.scope_id}</code>}
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" title="Reset usage"
                      onClick={() => resetMutation.mutate(b)}
                      disabled={resetMutation.isPending}>
                      <RotateCcw className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Delete budget"
                      onClick={() => deleteMutation.mutate(b)}
                      disabled={deleteMutation.isPending}>
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Daily</span>
                    <ProgressBar used={b.daily_used_cents} limit={b.daily_limit_cents} />
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Weekly</span>
                    <ProgressBar used={b.weekly_used_cents} limit={b.weekly_limit_cents} />
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Monthly</span>
                    <ProgressBar used={b.monthly_used_cents} limit={b.monthly_limit_cents} />
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <FloatingBar show={canSave}>
        <span className="text-xs text-muted-foreground">Unsaved changes</span>
        <Button variant="outline" size="sm" onClick={handleDiscard}>Discard</Button>
        <Button size="sm" onClick={saveBudget} disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </FloatingBar>
    </div>
  )
}
