// Middle Layer dashboard — Privacy layer config + known-secrets store.
// Wired into the navbar at /middle.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Shield, Plus, Trash2, Power, Loader2, Eye, EyeOff } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { addToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'

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
  const [newSecret, setNewSecret] = useState({ value: '', kind: 'api_key', label: '' })

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
      addToast('Configuration updated', { type: 'success' })
    },
    onError: (e: Error) => addToast(e.message, { type: 'error' }),
  })

  const addSecretMut = useMutation({
    mutationFn: (data: { value: string; kind: string; label?: string }) =>
      apiFetch<{ id: string }>('/api/middle/secrets', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
      setNewSecret({ value: '', kind: 'api_key', label: '' })
      addToast('Secret added', { type: 'success' })
    },
    onError: (e: Error) => addToast(e.message, { type: 'error' }),
  })

  const deleteSecret = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/middle/secrets?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['middle-secrets'] })
      queryClient.invalidateQueries({ queryKey: ['middle-stats'] })
      addToast('Secret removed', { type: 'success' })
    },
    onError: (e: Error) => addToast(e.message, { type: 'error' }),
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
    onError: (e: Error) => addToast(e.message, { type: 'error' }),
  })

  const cfg = config.data ?? {}
  const isLoading = config.isLoading || secrets.isLoading

  function toggleConfig(key: string, value: string) {
    updateConfig.mutate({ [key]: value })
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
              checked={cfg.middle_redaction_enabled === '1'}
              onCheckedChange={(v) => toggleConfig('middle_redaction_enabled', v ? '1' : '0')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Compression</Label>
              <p className="text-sm text-muted-foreground">Compress tool outputs before sending (coming soon).</p>
            </div>
            <Switch
              checked={cfg.middle_compression_enabled === '1'}
              onCheckedChange={(v) => toggleConfig('middle_compression_enabled', v ? '1' : '0')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="interceptor-model">Interceptor model ID</Label>
            <Input
              id="interceptor-model"
              value={cfg.middle_interceptor_model ?? ''}
              placeholder="e.g. 42 (models.id)"
              onChange={(e) => toggleConfig('middle_interceptor_model', e.target.value)}
            />
            <p className="text-sm text-muted-foreground">The model used for AI-based secret detection. Leave empty to disable.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="interceptor-timeout">Interceptor timeout (ms)</Label>
            <Input
              id="interceptor-timeout"
              value={cfg.middle_interceptor_timeout_ms ?? '4000'}
              onChange={(e) => toggleConfig('middle_interceptor_timeout_ms', e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Inbound interceptor</Label>
              <p className="text-sm text-muted-foreground">Scan model responses for new secrets (non-streaming only).</p>
            </div>
            <Switch
              checked={cfg.middle_interceptor_inbound_enabled === '1'}
              onCheckedChange={(v) => toggleConfig('middle_interceptor_inbound_enabled', v ? '1' : '0')}
            />
          </div>
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
          {/* Add secret */}
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
                <Button variant="outline" size="icon" onClick={() => setShowSecretValue(v => !v)}>
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

          {/* Secrets list */}
          {secrets.data && secrets.data.length > 0 && (
            <div className="space-y-2">
              {secrets.data.map(s => (
                <div key={s.id} className="flex items-center justify-between rounded-md border p-3">
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
    </div>
  )
}
