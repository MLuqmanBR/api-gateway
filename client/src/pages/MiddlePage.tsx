// Middle Layer dashboard — Privacy layer config + known-secrets store.
// Wired into the navbar at /middle.
import { Shield, Plus, Trash2, Power, Loader2, Eye, EyeOff, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { addToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { Textarea } from '@/components/ui/textarea'

type MiddleConfig = Record<string, string>

type SecretMeta = {
  id: string
  kind: string
  label: string
  addedBy: string
  createdAtMs: number
  enabled: boolean
  maskedPreview: string
}

type MiddleStats = {
  interceptor_failures: number
  active_secrets: number
}

export default function MiddlePage() {
  const queryClient = useQueryClient()
  const [showSecretValue, setShowSecretValue] = useState(false)
  const [newSecret, setNewSecret] = useState<{ value: string; kind: string; label: string }>({ value: '', kind: 'api_key', label: '' })
  const [localCfg, setLocalCfg] = useState<Record<string, string>>({})
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const config = useQuery<MiddleConfig>({
    queryKey: ['middle-config'],
    queryFn: () => apiFetch<MiddleConfig>('/api/middle/config'),
  })

  const secrets = useQuery<SecretMeta[]>({
    queryKey: ['middle-secrets'],
    queryFn: () => apiFetch<SecretMeta[]>('/api/middle/secrets'),
  })

  const stats = useQuery<MiddleStats>({
    queryKey: ['middle-stats'],
    queryFn: () => apiFetch<MiddleStats>('/api/middle/stats'),
  })

  const updateConfig = useMutation({
    mutationFn: (data: Partial<MiddleConfig>) =>
      apiFetch('/api/middle/config', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['middle-config'] })
      setLocalCfg({})
      addToast({ kind: 'success', title: 'Configuration updated', sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const addSecretMut = useMutation({
    mutationFn: (data: { value: string; kind: string; label?: string }) =>
      apiFetch<{ id: string }>('/api/middle/secrets', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
      setNewSecret({ value: '', kind: 'api_key', label: '' })
      addToast({ kind: 'success', title: 'Secret added', sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const deleteSecret = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/middle/secrets?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
      addToast({ kind: 'success', title: 'Secret removed', sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const toggleSecret = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/middle/secrets?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const bulkAddMut = useMutation({
    mutationFn: (data: { secrets: Array<{ value: string; kind: string; label?: string }> }) =>
      apiFetch<{ added: number; results: Array<{ id: string; existed: boolean }> }>('/api/middle/secrets/bulk', {
        method: 'POST', body: JSON.stringify(data),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
      const existed = data.results.filter(r => r.existed).length
      setBulkText('')
      addToast({ kind: 'success', title: `Added ${data.added - existed} new secret(s)${existed ? ` (${existed} already existed)` : ''}`, sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  const bulkDeleteMut = useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<{ removed: number }>(`/api/middle/secrets/bulk?ids=${ids.map(encodeURIComponent).join(',')}`, { method: 'DELETE' }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
      setSelected(new Set())
      addToast({ kind: 'success', title: `Removed ${data.removed} secret(s)`, sticky: false })
    },
    onError: (e: Error) => addToast({ kind: 'warning', title: e.message, sticky: false }),
  })

  // Header select-all checkbox: reflect "some but not all" via :indeterminate.
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const total = secrets.data?.length ?? 0
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && selected.size < total
    }
  }, [selected, secrets.data])
  // Selection is cleared implicitly when selected IDs stop appearing in the refreshed list
  // (after delete/add, the re-fetched secrets data no longer contains those IDs).
  const cfg = config.data ?? {}
  const isLoading = config.isLoading || secrets.isLoading

  function configValue(key: string, fallback: string = ''): string {
    return localCfg[key] ?? cfg[key] ?? fallback
  }
  function setConfig(key: string, value: string) {
    setLocalCfg(prev => {
      const next = { ...prev }
      if (value === (cfg[key] ?? '')) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }
  const hasChanges = Object.entries(localCfg).some(([k, v]) => v !== (cfg[k] ?? ''))

  function handleBulkAdd() {
    const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return
    const secrets = lines.map(line => {
      const parts = line.split(/\s*,\s*/)
      return {
        value: parts[0] ?? '',
        kind: parts[1] ?? 'api_key',
        label: parts[2] ?? '',
      }
    }).filter(s => s.value)
    if (secrets.length === 0) return
    bulkAddMut.mutate({ secrets })
  }

  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }


  return (
    <div className="space-y-6">
      <PageHeader title="Middle Layer" description="Privacy layer: redaction, interceptor, and known-secrets store." />

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {/* Config */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5" /> Configuration</CardTitle>
          <CardDescription>Toggle the privacy layer features and configure the AI interceptor.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Redaction</Label>
              <p className="text-sm text-muted-foreground">Replace known secrets with placeholders before sending to the model.</p>
            </div>
            <Switch
              checked={configValue('middle_redaction_enabled') === '1'}
              onCheckedChange={(v) => setConfig('middle_redaction_enabled', v ? '1' : '0')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="interceptor-model">Interceptor model ID</Label>
            <Input
              id="interceptor-model"
              value={configValue('middle_interceptor_model')}
              placeholder="e.g. 42 (models.id)"
              onChange={(e) => setConfig('middle_interceptor_model', e.target.value)}
            />
            <p className="text-sm text-muted-foreground">The model used for AI-based secret detection. Leave empty to disable.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="interceptor-timeout">Interceptor timeout (ms)</Label>
            <Input
              id="interceptor-timeout"
              value={configValue('middle_interceptor_timeout_ms', '4000')}
              onChange={(e) => setConfig('middle_interceptor_timeout_ms', e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Inbound interceptor</Label>
              <p className="text-sm text-muted-foreground">Scan model responses for new secrets (non-streaming only).</p>
            </div>
            <Switch
              checked={configValue('middle_interceptor_inbound_enabled') === '1'}
              onCheckedChange={(v) => setConfig('middle_interceptor_inbound_enabled', v ? '1' : '0')}
            />
          </div>
        </CardContent>
      </Card>

      {/* Prompt Compression */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" /> Prompt Compression</CardTitle>
          <CardDescription>Compress tool outputs before sending to the model. Runs after redaction.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Compression</Label>
              <p className="text-sm text-muted-foreground">Master toggle for the compression pipeline.</p>
            </div>
            <Switch
              checked={configValue('middle_compression_enabled') === '1'}
              onCheckedChange={(v) => setConfig('middle_compression_enabled', v ? '1' : '0')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>SmartCrusher</Label>
              <p className="text-sm text-muted-foreground">Drop low-value rows from JSON-array tool outputs.</p>
            </div>
            <Switch
              checked={configValue('middle_compression_smart_crusher') === '1'}
              onCheckedChange={(v) => setConfig('middle_compression_smart_crusher', v ? '1' : '0')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Emit sentinel</Label>
              <p className="text-sm text-muted-foreground">Insert a note when rows are dropped (recommended).</p>
            </div>
            <Switch
              checked={configValue('middle_compression_emit_sentinel', '1') !== '0'}
              onCheckedChange={(v) => setConfig('middle_compression_emit_sentinel', v ? '1' : '0')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>SmartCrusher lossless-only</Label>
              <p className="text-sm text-muted-foreground">Only re-render with TOON, never drop rows.</p>
            </div>
            <Switch
              checked={configValue('middle_compression_smart_crusher_lossless_only', '1') !== '0'}
              onCheckedChange={(v) => setConfig('middle_compression_smart_crusher_lossless_only', v ? '1' : '0')}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label htmlFor="protect-recent">Protect recent</Label>
              <Input
                id="protect-recent"
                type="number"
                min={0}
                max={12}
                value={configValue('middle_compression_protect_recent', '4')}
                onChange={(e) => setConfig('middle_compression_protect_recent', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="min-savings-ratio">Min savings ratio</Label>
              <Input
                id="min-savings-ratio"
                type="number"
                step={0.05}
                min={0.05}
                max={0.5}
                value={configValue('middle_compression_min_savings_ratio', '0.15')}
                onChange={(e) => setConfig('middle_compression_min_savings_ratio', e.target.value)}
              />
            </div>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Off-limits rules (what compression never touches)
            </summary>
            <ul className="mt-2 ml-4 space-y-1 text-muted-foreground">
              <li>Fenced code blocks (``` and ~~~)</li>
              <li>Inline backtick code spans</li>
              <li>Redaction placeholders (⟦R1:abc123⟧)</li>
              <li>role:"tool" messages (lossless by default)</li>
              <li>Compression sentinels (⟦C7:&lt;&lt;...&gt;&gt;⟧)</li>
              <li>JSON tool schemas and system messages</li>
            </ul>
          </details>
        </CardContent>
      </Card>

      {/* Stats */}
      {stats.data && (
        <Card>
          <CardHeader>
            <CardTitle>Stats</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-8">
            <div>
              <div className="text-2xl font-bold">{stats.data.active_secrets}</div>
              <div className="text-sm text-muted-foreground">Active secrets</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.data.interceptor_failures}</div>
              <div className="text-sm text-muted-foreground">Interceptor failures</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Secrets */}
      <Card>
        <CardHeader>
          <CardTitle>Known Secrets</CardTitle>
          <CardDescription>Secrets that are automatically replaced with placeholders in outbound requests.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add secret — Single / Bulk toggle */}
          <div className="flex gap-2">
            <Button variant={!bulkMode ? 'default' : 'outline'} size="sm" onClick={() => setBulkMode(false)}>Single</Button>
            <Button variant={bulkMode ? 'default' : 'outline'} size="sm" onClick={() => setBulkMode(true)}>Bulk</Button>
          </div>

          {!bulkMode ? (
            <div className="flex gap-2 items-end">
              <div className="flex-1 space-y-1">
                <Label htmlFor="secret-value">Value</Label>
                <div className="flex gap-1">
                  <Input
                    id="secret-value"
                    type={showSecretValue ? 'text' : 'password'}
                    value={newSecret.value}
                    onChange={(e) => setNewSecret(s => ({ ...s, value: e.target.value }))}
                    placeholder="sk-…"
                  />
                  <Button variant="outline" size="icon" onClick={() => setShowSecretValue(!showSecretValue)}>
                    {showSecretValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="w-32 space-y-1">
                <Label htmlFor="secret-kind">Kind</Label>
                <Input
                  id="secret-kind"
                  value={newSecret.kind}
                  onChange={(e) => setNewSecret(s => ({ ...s, kind: e.target.value }))}
                />
              </div>
              <div className="w-32 space-y-1">
                <Label htmlFor="secret-label">Label</Label>
                <Input
                  id="secret-label"
                  value={newSecret.label}
                  onChange={(e) => setNewSecret(s => ({ ...s, label: e.target.value }))}
                />
              </div>
              <Button
                onClick={() => addSecretMut.mutate(newSecret)}
                disabled={!newSecret.value || addSecretMut.isPending}
              >
                {addSecretMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="bulk-textarea">Paste secrets (one per line: value , kind , label)</Label>
                <Textarea
                  id="bulk-textarea"
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={'sk-or-f83oirhdjfhdkjasd , api_key , account1\nnvapi-eowenyr834bfhjdsba , api_key , account1\ncfai-294831232434 , apiKey , acc_1234'}
                  className="font-mono text-sm min-h-[120px]"
                />
              </div>
              <Button
                onClick={handleBulkAdd}
                disabled={!bulkText.trim() || bulkAddMut.isPending}
              >
                {bulkAddMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add {bulkText.split('\n').map(l => l.trim()).filter(Boolean).length || ''} secret{bulkText.split('\n').map(l => l.trim()).filter(Boolean).length !== 1 ? 's' : ''}
              </Button>
            </div>
          )}

          {/* Secrets list */}
          {secrets.data && secrets.data.length > 0 && (
            <div className="space-y-2">
              {selected.size > 0 && (
                <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 p-2">
                  <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => bulkDeleteMut.mutate([...selected])}
                      disabled={bulkDeleteMut.isPending}
                    >
                      {bulkDeleteMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Delete selected ({selected.size})
                    </Button>
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-4 w-4 rounded border-input"
                  checked={secrets.data.length > 0 && selected.size === secrets.data.length}
                  onChange={(e) => {
                    if (e.target.checked) setSelected(new Set(secrets.data.map(s => s.id)))
                    else setSelected(new Set())
                  }}
                />
                Select all
              </label>
              {secrets.data.map(s => (
                <div key={s.id} className="flex items-center justify-between rounded-md border p-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      aria-label={`Select secret ${s.maskedPreview}${s.label ? ` (${s.label})` : ''}`}
                      checked={selected.has(s.id)}
                      onChange={() => toggleSelected(s.id)}
                    />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{s.maskedPreview}</span>
                        <span className="text-xs text-muted-foreground">{s.kind}</span>
                        {s.label && <span className="text-xs text-muted-foreground">· {s.label}</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Added by {s.addedBy} · {new Date(s.createdAtMs).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleSecret.mutate({ id: s.id, enabled: !s.enabled })}
                      title={s.enabled ? 'Disable' : 'Enable'}
                    >
                      <Power className={`h-4 w-4 ${s.enabled ? 'text-green-500' : 'text-muted-foreground'}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteSecret.mutate(s.id)}
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {secrets.data && secrets.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No secrets stored yet.</p>
          )}
        </CardContent>
      </Card>
      <FloatingBar show={hasChanges}>
        <span className="text-xs text-muted-foreground">Unsaved changes</span>
        <Button variant="outline" size="sm" onClick={() => setLocalCfg({})}>Discard</Button>
        <Button size="sm" onClick={() => updateConfig.mutate(localCfg)} disabled={updateConfig.isPending}>
          {updateConfig.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </FloatingBar>
    </div>
  )
}
