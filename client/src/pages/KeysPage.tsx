import { addToast } from '@/lib/toast'
import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useEventStream } from '@/lib/use-event-stream'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform, CustomProvider, Model } from '../../../shared/types'
import { Pencil, ExternalLink, Plus, X } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useDiscardGuard } from '@/lib/use-discard-guard'
import { formatSqliteUtcToLocalTime, maskKey, cn } from '@/lib/utils'

// Small "Get API key" external link shown next to a provider (#137).
function GetKeyLink({ url }: { url: string }) {
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      Get API key
      <ExternalLink className="size-3" />
    </a>
  )
}
// Clipboard helper that works on non-secure origins (plain-http LAN access,
// e.g. the dashboard's own dev:lan mode): navigator.clipboard is undefined
// there and writeText() rejects, so fall back to the execCommand textarea
// trick. Returns true only when the text actually landed on the clipboard.
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path below
    }
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// `url` points to each provider's key-management / signup page so the Keys page
// can show a "Get API key" shortcut (#137). OpenCode Zen's key is free from
// opencode.ai/auth — no card needed; billing only applies to paid models (#128).
// `keyless: true` providers (Kilo/Pollinations/OVH/LLM7 anonymous tiers) need no API key — the
// form disables the key field and submits a sentinel the backend stores so
// routing treats the platform as configured.
const PLATFORMS: { value: Platform; label: string; url: string; keyless?: boolean }[] = [
  { value: 'google', label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
  { value: 'groq', label: 'Groq', url: 'https://console.groq.com/keys' },
  { value: 'cerebras', label: 'Cerebras', url: 'https://cloud.cerebras.ai' },
  { value: 'nvidia', label: 'NVIDIA NIM', url: 'https://build.nvidia.com/settings/api-keys' },
  { value: 'mistral', label: 'Mistral', url: 'https://console.mistral.com/api-keys/' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
  { value: 'github', label: 'GitHub Models', url: 'https://github.com/settings/tokens' },
  { value: 'cohere', label: 'Cohere', url: 'https://dashboard.cohere.com/api-keys' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', url: 'https://dash.cloudflare.com' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)', url: 'https://z.ai/manage-apikey/apikey-list' },
  { value: 'ollama', label: 'Ollama Cloud', url: 'https://ollama.com/settings/keys' },
  { value: 'kilo', label: 'Kilo Gateway (no key needed)', url: 'https://app.kilo.ai', keyless: true },
  { value: 'pollinations', label: 'Pollinations (no key needed)', url: 'https://pollinations.ai', keyless: true },
  { value: 'ovh', label: 'OVH AI Endpoints (no key needed)', url: 'https://endpoints.ai.cloud.ovh.net', keyless: true },
  { value: 'llm7', label: 'LLM7 (no key needed)', url: 'https://llm7.io', keyless: true },
  { value: 'opencode', label: 'OpenCode Zen (free key)', url: 'https://opencode.ai/auth' },
  { value: 'commandcode', label: 'CommandCode', url: '' },
];

// Set of built-in platform slugs — used to widen the Edit button so built-in
// providers (Groq, Cerebras, etc.) can be edited via /api/platforms/:slug/settings.
const PLATFORMS_SLUGS: Set<string> = new Set(PLATFORMS.map(p => p.value));

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

function UnifiedKeySection() {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)

  const { data, isError } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? maskKey(apiKey) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  async function copy() {
    if (!(await copyToClipboard(apiKey))) {
      addToast({ kind: 'warning', title: 'Copy failed', description: 'Clipboard is unavailable on this connection.', sticky: false })
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Your unified API key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this as your OpenAI <code className="font-mono">api_key</code>; it authenticates requests to this proxy.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmRegen(true)}
          disabled={regenerate.isPending || isError}
        >
          Regenerate
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          Can't reach the server on <code className="font-mono">{baseUrl.replace('/v1', '')}</code>. Make sure the
          backend is running. <code className="font-mono">npm run dev</code> starts both, and the server logs print
          under the <code className="font-mono">server</code> prefix.
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
            {showKey ? apiKey : masked}
          </code>
          <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
            {showKey ? 'Hide' : 'Show'}
          </Button>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Base URL</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">Chat</span>
        <code className="font-mono">/v1/chat/completions</code>
        <span className="text-muted-foreground">Responses</span>
        <code className="font-mono">/v1/responses</code>
        <span className="text-muted-foreground">Embeddings</span>
        <code className="font-mono">/v1/embeddings <span className="text-muted-foreground">(model: "auto" or a family from the Embeddings tab)</span></code>
      </div>
      <ConfirmDialog
        open={confirmRegen}
        onOpenChange={setConfirmRegen}
        title="Regenerate unified API key?"
        description="Regenerating invalidates every existing client using the current key."
        confirmLabel="Regenerate"
        pending={regenerate.isPending}
        onConfirm={() => { setConfirmRegen(false); regenerate.mutate() }}
      />
    </section>
  )
}

// ── F3: Client keys section ──────────────────────────────────────────────
// Per-deployment / per-script API keys with model allowlists + expiry. The
// secret <key_id>:<secret> is shown ONCE on mint. Uses the same masked-display
// pattern as UnifiedKeySection (lib/utils maskKey: '****' + last 3 chars).

interface ClientKey {
  id: string
  label: string
  enabled: boolean
  expires_at_ms: number | null
  model_allowlist: string[] | null
  rpm_override: number | null
  created_at_ms: number
}

function ClientKeysSection() {
  const queryClient = useQueryClient()
  const [newLabel, setNewLabel] = useState('')
  const [mintedKey, setMintedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data: keys = [] } = useQuery<ClientKey[]>({
    queryKey: ['client-keys'],
    queryFn: async () => {
      // SQLite stores this column as INTEGER 0/1; coerce to boolean here so
      // everything below treats `enabled` as a plain flag while toggles keep
      // sending real booleans over PATCH.
      const rows = await apiFetch<(Omit<ClientKey, 'enabled'> & { enabled: number })[]>('/api/keys/client')
      return rows.map(k => ({ ...k, enabled: k.enabled === 1 }))
    },
  })

  const mint = useMutation({
    mutationFn: (label: string) =>
      apiFetch<{ key: string; id: string; label: string }>('/api/keys/client', {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: (data) => {
      setMintedKey(data.key)
      setNewLabel('')
      queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/keys/client/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-keys'] }),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/keys/client/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-keys'] }),
  })

  async function copyMinted() {
    if (!mintedKey) return
    if (!(await copyToClipboard(mintedKey))) {
      addToast({ kind: 'warning', title: 'Copy failed', description: 'Clipboard is unavailable on this connection.', sticky: false })
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Client keys</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Per-deployment credentials with scoped model access. Use these instead of the master key for scripts, CI, or teammates.
          </p>
        </div>
      </div>

      {mintedKey && (
        <div className="mb-3 rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2.5">
          <p className="text-xs font-medium text-green-600 dark:text-green-400 mb-1.5">
            Copy this key now — the secret is shown only once:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate">
              {mintedKey}
            </code>
            <Button variant="outline" size="sm" onClick={copyMinted}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMintedKey(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); if (newLabel.trim()) mint.mutate(newLabel.trim()) }}
        className="flex items-end gap-2 mb-4"
      >
        <div className="space-y-1.5 flex-1">
          <Label className="text-xs">Label</Label>
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. CI pipeline, teammate script"
            className="text-xs"
          />
        </div>
        <Button type="submit" size="sm" disabled={mint.isPending || !newLabel.trim()}>
          {mint.isPending ? 'Minting…' : 'Mint key'}
        </Button>
      </form>

      {keys.length > 0 ? (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-xs">
              <code className="font-mono text-muted-foreground truncate" style={{ maxWidth: 180 }}>{k.id}</code>
              <span className="font-medium truncate flex-1">{k.label}</span>
              {k.enabled ? (
                <span className="text-green-600 dark:text-green-400">active</span>
              ) : (
                <span className="text-muted-foreground">disabled</span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggle.mutate({ id: k.id, enabled: !k.enabled })}
              >
                {k.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate(k.id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No client keys yet. Mint one above.</p>
      )}
    </section>
  )
}
// Modal shown by the "Add New Platform" tile in the Platforms section. Adds
// the user's first custom OpenAI-compatible endpoint to the catalog. After
// the row is created the same form lets them add models immediately.

function AddPlatformModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (slug: string) => void
}) {
  const queryClient = useQueryClient()
  const [slug, setSlug] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [rpmLimit, setRpmLimit] = useState<string>('')
  const [rpdLimit, setRpdLimit] = useState<string>('')
  const [tpmLimit, setTpmLimit] = useState<string>('')
  const [tpdLimit, setTpdLimit] = useState<string>('')
  const [parallelEnabled, setParallelEnabled] = useState(false)
  const [maxParallelRequests, setMaxParallelRequests] = useState(4)
  const [stickySessionsEnabled, setStickySessionsEnabled] = useState(false)
  const [keyless, setKeyless] = useState(false)
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>('openai')
  const [keyFormat, setKeyFormat] = useState<'simple' | 'colon'>('simple')

  // N55: Escape/backdrop must not silently discard typed input — anything
  // deviating from the pristine defaults routes a close through a confirm.
  const hasInput =
    slug !== '' ||
    displayName !== '' ||
    baseUrl !== '' ||
    rpmLimit !== '' ||
    rpdLimit !== '' ||
    tpmLimit !== '' ||
    tpdLimit !== '' ||
    parallelEnabled ||
    stickySessionsEnabled ||
    keyless ||
    apiFormat !== 'openai' ||
    keyFormat !== 'simple'
  const { confirming, setConfirming, requestClose } = useDiscardGuard(hasInput, onClose)

  const create = useMutation<{ slug: string }, Error, Record<string, unknown>>({
    mutationFn: (body) => apiFetch('/api/custom-providers', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data: { slug: string }) => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      onCreated(data.slug)
      setSlug('')
      setDisplayName('')
      setBaseUrl('')
      setShowAdvanced(false)
      setRpmLimit('')
      setRpdLimit('')
      setTpmLimit('')
      setTpdLimit('')
      setParallelEnabled(false)
      setStickySessionsEnabled(false)
      setKeyless(false)
      setKeyFormat('simple')
      setApiFormat('openai')
    },
  })

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={requestClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border bg-card p-5 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium">Add a custom platform</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Point at any OpenAI-compatible endpoint: Ollama, LM Studio, llama.cpp, vLLM, a remote gateway.
              Models are added separately once the provider exists.
            </p>
          </div>
          <Button variant="ghost" size="xs" onClick={requestClose}>
            <X className="size-4" />
          </Button>
        </div>
        <form
          onSubmit={e => {
            e.preventDefault()
            const body: Record<string, unknown> = { slug: slug.trim(), displayName: displayName.trim(), baseUrl: baseUrl.trim(), keyless, apiFormat, keyFormat }
            if (showAdvanced) {
              if (rpmLimit) body.rpmLimit = parseInt(rpmLimit, 10)
              if (rpdLimit) body.rpdLimit = parseInt(rpdLimit, 10)
              if (tpmLimit) body.tpmLimit = parseInt(tpmLimit, 10)
              if (tpdLimit) body.tpdLimit = parseInt(tpdLimit, 10)
              body.maxParallelRequests = parallelEnabled ? maxParallelRequests : null
              body.stickySessionsEnabled = stickySessionsEnabled
            }
            create.mutate(body)
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label className="text-xs">Slug (the platform id)</Label>
            <Input
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="my-ollama"
              className="font-mono text-xs"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              Lowercase letters, digits, dashes; 2-32 chars. Cannot collide with built-in platforms.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="My Ollama box"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Base URL</Label>
            <Input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="http://192.168.1.10:11434/v1"
              className="font-mono text-xs"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced(s => !s)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>
          {showAdvanced && (
            <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">RPM limit (blank = none)</Label>
                <Input type="number" min={0} value={rpmLimit} onChange={e => setRpmLimit(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">RPD limit</Label>
                <Input type="number" min={0} value={rpdLimit} onChange={e => setRpdLimit(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">TPM limit</Label>
                <Input type="number" min={0} value={tpmLimit} onChange={e => setTpmLimit(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">TPD limit</Label>
                <Input type="number" min={0} value={tpdLimit} onChange={e => setTpdLimit(e.target.value)} className="font-mono text-xs" />
              </div>
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">Parallel requests</Label>
              <div className="flex items-center gap-3 mt-1">
                <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                  <Switch checked={parallelEnabled} onCheckedChange={setParallelEnabled} />
                  Limit
                </label>
                {parallelEnabled && (
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={maxParallelRequests}
                    onChange={e => setMaxParallelRequests(parseInt(e.target.value, 10) || 1)}
                    className="font-mono text-xs w-20"
                  />
                )}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Caps in-flight requests across all models on this provider. When at the limit, every model is skipped until a slot frees.
              </p>
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">API format</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                OpenAI-compatible endpoints use /v1/chat/completions. Anthropic endpoints use /v1/messages.
              </p>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <span className={apiFormat === 'openai' ? '' : 'text-muted-foreground'}>OpenAI</span>
                <Switch checked={apiFormat === 'anthropic'} onCheckedChange={c => setApiFormat(c ? 'anthropic' : 'openai')} />
                <span className={apiFormat === 'anthropic' ? '' : 'text-muted-foreground'}>Anthropic</span>
              </label>
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">Credential format</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                How the API key is structured. "Bearer token" sends the whole key as-is.
                "Account ID + API key" splits the key at the first colon — the left part
                becomes the account_id (substituted into {'{account_id}'} in the base URL),
                and the right part is the bearer token.
              </p>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <span className={keyFormat === 'simple' ? '' : 'text-muted-foreground'}>Bearer token</span>
                <Switch checked={keyFormat === 'colon'} onCheckedChange={c => setKeyFormat(c ? 'colon' : 'simple')} />
                <span className={keyFormat === 'colon' ? '' : 'text-muted-foreground'}>Account ID + API key</span>
              </label>
              {keyFormat === 'colon' && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Use {'{account_id}'} as a placeholder — it will be replaced with each key's
                  account ID at request time. Example:{' '}
                  <code className="text-xs">https://{'{account_id}'}.api.example.com/v1</code>
                </p>
              )}
            </div>
            <div className="border-t pt-3 mt-1">
              <Label className="text-xs">Sticky keys (cache affinity)</Label>
              <p className="text-[10px] text-muted-foreground mb-1">
                Route the same conversation to the same API key for better cache hits on providers like LongCAT.
              </p>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <Switch checked={stickySessionsEnabled} onCheckedChange={setStickySessionsEnabled} />
                <span>{stickySessionsEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
            </>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Switch checked={keyless} onCheckedChange={setKeyless} />
            <span className="text-xs text-muted-foreground">No API key required (anonymous/sentinel)</span>
          </div>
          {create.isError && (
            <p className="text-destructive text-xs">{(create.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!slug || !displayName || !baseUrl || create.isPending}>
              {create.isPending ? 'Adding…' : 'Add platform'}
            </Button>
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => { if (!o) setConfirming(false) }}
        title="Discard changes?"
        description="You've started entering a platform. Close without saving it?"
        confirmLabel="Discard"
        onConfirm={onClose}
      />
    </div>
  )
}

// ── Edit-platform modal ───────────────────────────────────────────────────
// Reused for the PATCH /api/custom-providers/:slug flow. Lets the user
// correct a typo in the baseUrl or the display name without re-registering
// the slug (which is the platform id and would orphan existing models).

// Per-platform settings shape returned by GET /api/platforms/:slug/settings.
type BuiltInProviderSettings = {
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  stickySessionsEnabled: boolean;
};

function EditPlatformModal({
  slug,
  provider,
  kind,
  onClose,
  onSaved,
}: {
  slug: string
  provider?: CustomProvider
  kind: 'custom' | 'built-in'
  onClose: () => void
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const isCustom = kind === 'custom' && provider !== undefined;
  // Built-in providers fetch their settings fresh on modal open so the
  // form seeds from current row state. Customs don't need this fetch
  // (their fields come from the `provider` prop above).
  const { data: builtInSettings } = useQuery<BuiltInProviderSettings | null>({
    queryKey: ['platforms', slug, 'settings'],
    queryFn: () => apiFetch(`/api/platforms/${slug}/settings`),
    enabled: kind === 'built-in',
 });
  const initRpm = isCustom ? provider.rpmLimit : builtInSettings?.rpmLimit;
  const initRpd = isCustom ? provider.rpdLimit : builtInSettings?.rpdLimit;
  const initTpm = isCustom ? provider.tpmLimit : builtInSettings?.tpmLimit;
  const initTpd = isCustom ? provider.tpdLimit : builtInSettings?.tpdLimit;
  const initSticky = isCustom
    ? (provider.stickySessionsEnabled ?? false)
    : (builtInSettings?.stickySessionsEnabled ?? false);

  const [newSlug, setNewSlug] = useState(slug)
  const [displayName, setDisplayName] = useState(isCustom ? provider.displayName : '')
  const [baseUrl, setBaseUrl] = useState(isCustom ? provider.baseUrl : '')
  const [rpmLimit, setRpmLimit] = useState(initRpm?.toString() ?? '')
  const [rpdLimit, setRpdLimit] = useState(initRpd?.toString() ?? '')
  const [tpmLimit, setTpmLimit] = useState(initTpm?.toString() ?? '')
  const [tpdLimit, setTpdLimit] = useState(initTpd?.toString() ?? '')
  const [parallelEnabled, setParallelEnabled] = useState(isCustom ? provider.maxParallelRequests != null : false)
  const [maxParallelRequests, setMaxParallelRequests] = useState(isCustom ? (provider.maxParallelRequests ?? 4) : 4)
  const [stickySessionsEnabled, setStickySessionsEnabled] = useState(initSticky)
  const [keyless, setKeyless] = useState(isCustom ? provider.keyless : false)
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>(
    isCustom ? (provider.apiFormat ?? 'openai') : 'openai',
  )
  const [keyFormat, setKeyFormat] = useState<'simple' | 'colon'>(
    isCustom ? ((provider.keyFormat ?? 'simple') as 'simple' | 'colon') : 'simple',
  )
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Built-in settings load asynchronously: seeding the inputs once at mount
  // raced the query (inputs rendered empty, and the save diff then sent
  // `null` for every limit — wiping them). Sync once when the data lands,
  // and block saving until then; the one-shot ref keeps a mid-edit refetch
  // from clobbering what the user has typed.
  const settingsLoaded = isCustom || builtInSettings !== undefined;
  const limitsSyncedRef = useRef(false);
  useEffect(() => {
    if (limitsSyncedRef.current || builtInSettings == null) return;
    limitsSyncedRef.current = true;
    setRpmLimit(builtInSettings.rpmLimit?.toString() ?? '');
    setRpdLimit(builtInSettings.rpdLimit?.toString() ?? '');
    setTpmLimit(builtInSettings.tpmLimit?.toString() ?? '');
    setTpdLimit(builtInSettings.tpdLimit?.toString() ?? '');
    setStickySessionsEnabled(builtInSettings.stickySessionsEnabled ?? false);
  }, [builtInSettings])

  // Same field-diff the submit sends: nonzero ⇒ there is edited input that a
  // backdrop click or Escape would silently throw away (N55).
  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (isCustom) {
      // Custom-only editable fields: slug, displayName, baseUrl,
      // parallelRequests, keyless, apiFormat.
      if (newSlug.trim() !== slug) body.slug = newSlug.trim();
      if (displayName.trim() !== provider.displayName) body.displayName = displayName.trim();
      if (baseUrl.trim() !== provider.baseUrl) body.baseUrl = baseUrl.trim();
      const newMax = parallelEnabled ? maxParallelRequests : null;
      if (newMax !== provider.maxParallelRequests) body.maxParallelRequests = newMax;
      if (keyless !== provider.keyless) body.keyless = keyless;
      if (apiFormat !== (provider.apiFormat ?? 'openai')) body.apiFormat = apiFormat;
      if (keyFormat !== ((provider.keyFormat ?? 'simple') as string)) body.keyFormat = keyFormat;
    }
    // Common fields: limits + sticky toggle.
    const oldRpm = initRpm ?? null;
    const newRpm = rpmLimit ? parseInt(rpmLimit, 10) : null;
    if (newRpm !== oldRpm) body.rpmLimit = newRpm;
    const oldRpd = initRpd ?? null;
    const newRpd = rpdLimit ? parseInt(rpdLimit, 10) : null;
    if (newRpd !== oldRpd) body.rpdLimit = newRpd;
    const oldTpm = initTpm ?? null;
    const newTpm = tpmLimit ? parseInt(tpmLimit, 10) : null;
    if (newTpm !== oldTpm) body.tpmLimit = newTpm;
    const oldTpd = initTpd ?? null;
    const newTpd = tpdLimit ? parseInt(tpdLimit, 10) : null;
    if (newTpd !== oldTpd) body.tpdLimit = newTpd;
    if (stickySessionsEnabled !== initSticky) body.stickySessionsEnabled = stickySessionsEnabled;
    return body;
  }

  const dirty = settingsLoaded && Object.keys(buildBody()).length > 0;
  const { confirming, setConfirming, requestClose } = useDiscardGuard(dirty, onClose);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      const endpoint = isCustom
        ? `/api/custom-providers/${slug}`
        : `/api/platforms/${slug}/settings`;
      return apiFetch(endpoint, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] });
      queryClient.invalidateQueries({ queryKey: ['keys'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['platforms'] });
      onSaved();
    },
  })

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={requestClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border bg-card p-5 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium">Edit platform</h3>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">{slug}</p>
          </div>
          <Button variant="ghost" size="xs" onClick={requestClose}><X className="size-4" /></Button>
        </div>
        <form
          onSubmit={e => {
            e.preventDefault();
            const body = buildBody();
            if (Object.keys(body).length === 0) { onClose(); return; }
            save.mutate(body);
          }}
          className="space-y-3"
        >
          {isCustom && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Slug</Label>
                <Input value={newSlug} onChange={e => setNewSlug(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Display name</Label>
                <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Base URL</Label>
                <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className="font-mono text-xs" />
              </div>
            </>
          )}
          <button type="button" onClick={() => setShowAdvanced(s => !s)} className="text-xs text-muted-foreground hover:text-foreground">
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>
          {showAdvanced && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label className="text-xs">RPM limit</Label><Input type="number" min={0} value={rpmLimit} onChange={e => setRpmLimit(e.target.value)} className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label className="text-xs">RPD limit</Label><Input type="number" min={0} value={rpdLimit} onChange={e => setRpdLimit(e.target.value)} className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label className="text-xs">TPM limit</Label><Input type="number" min={0} value={tpmLimit} onChange={e => setTpmLimit(e.target.value)} className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label className="text-xs">TPD limit</Label><Input type="number" min={0} value={tpdLimit} onChange={e => setTpdLimit(e.target.value)} className="font-mono text-xs" /></div>
              </div>
              {isCustom && (
                <>
                  <div className="border-t pt-3 mt-1">
                    <Label className="text-xs">Parallel requests</Label>
                    <div className="flex items-center gap-3 mt-1">
                      <label className="flex items-center gap-1.5 cursor-pointer text-xs"><Switch checked={parallelEnabled} onCheckedChange={setParallelEnabled} />Limit</label>
                      {parallelEnabled && <Input type="number" min={1} max={100} value={maxParallelRequests} onChange={e => setMaxParallelRequests(parseInt(e.target.value, 10) || 1)} className="font-mono text-xs w-20" />}
                    </div>
                  </div>
                  <div className="border-t pt-3 mt-1">
                    <Label className="text-xs">API format</Label>
                    <p className="text-[10px] text-muted-foreground mb-1">
                      OpenAI-compatible endpoints use /v1/chat/completions. Anthropic endpoints use /v1/messages.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer text-xs">
                      <span className={apiFormat === 'openai' ? '' : 'text-muted-foreground'}>OpenAI</span>
                      <Switch checked={apiFormat === 'anthropic'} onCheckedChange={c => setApiFormat(c ? 'anthropic' : 'openai')} />
                      <span className={apiFormat === 'anthropic' ? '' : 'text-muted-foreground'}>Anthropic</span>
                    </label>
                  </div>
                  <div className="border-t pt-3 mt-1">
                    <Label className="text-xs">Credential format</Label>
                    <p className="text-[10px] text-muted-foreground mb-1">
                      How the API key is structured. "Bearer token" sends the whole key as-is.
                      "Account ID + API key" splits the key at the first colon — the left part
                      becomes the account_id (substituted into {'{account_id}'} in the base URL),
                      and the right part is the bearer token.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer text-xs">
                      <span className={keyFormat === 'simple' ? '' : 'text-muted-foreground'}>Bearer token</span>
                      <Switch checked={keyFormat === 'colon'} onCheckedChange={c => setKeyFormat(c ? 'colon' : 'simple')} />
                      <span className={keyFormat === 'colon' ? '' : 'text-muted-foreground'}>Account ID + API key</span>
                    </label>
                    {keyFormat === 'colon' && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Use {'{account_id}'} as a placeholder — it will be replaced with each key's
                        account ID at request time. Example:{' '}
                        <code className="text-xs">https://{'{account_id}'}.api.example.com/v1</code>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Switch checked={keyless} onCheckedChange={setKeyless} />
                    <span className="text-xs text-muted-foreground">No API key required</span>
                  </div>
                </>
              )}
              <div className="border-t pt-3 mt-1">
                <Label className="text-xs">Sticky keys (cache affinity)</Label>
                <p className="text-[10px] text-muted-foreground mb-1">
                  Route the same conversation to the same API key for better cache hits on providers like LongCAT.
                </p>
                <label className="flex items-center gap-2 cursor-pointer text-xs">
                  <Switch checked={stickySessionsEnabled} onCheckedChange={setStickySessionsEnabled} />
                  <span>{stickySessionsEnabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </div>
            </>
          )}
          {save.isError && <p className="text-destructive text-xs">{(save.error as Error).message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={save.isPending || !settingsLoaded}>
              {!settingsLoaded ? 'Loading…' : save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => { if (!o) setConfirming(false) }}
        title="Discard changes?"
        description="You have unsaved edits to this platform. Close without saving?"
        confirmLabel="Discard"
        onConfirm={onClose}
      />
    </div>
  )
}
// Custom model registration form: adds a single model to any provider —
// built-in or custom. Defaults are chosen so the user can submit with just
// the model id and display name; the rest of the form's "advanced" fields
// take sensible defaults and can be edited later from the Fallback page.
//   contextWindow = 128_000  (matches the modern LLM ceiling)
//   supportsTools = true     (most OpenAI-compat endpoints do)
//   supportsVision = false   (text-only is the safe default)
//   ranks = 50 / 50          (middle of the bandit scoring range)
//   sizeLabel = 'Custom'     (sorts below named tiers)

function CustomModelsSection() {
  const queryClient = useQueryClient()
  const { data: customProviders = [] } = useQuery<CustomProvider[]>({
    queryKey: ['custom-providers'],
    queryFn: () => apiFetch('/api/custom-providers'),
  })
  const activeCustom = customProviders.filter(cp => !cp.archived)
  const { data: models = [] } = useQuery<Model[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })
  const [provider, setProvider] = useState<string | null>(null)
  const [modelId, setModelId] = useState('')
  // L61: model archive is destructive — confirmed via ConfirmDialog.
  const [archiveModelTarget, setArchiveModelTarget] = useState<{ id: number; modelId: string } | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [contextWindow, setContextWindow] = useState(128000)
  const [maxOutputTokens, setMaxOutputTokens] = useState(null as number | null)
  const [supportsTools, setSupportsTools] = useState(true)
  const [supportsVision, setSupportsVision] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [intelligenceRank, setIntelligenceRank] = useState(50)
  const [speedRank, setSpeedRank] = useState(50)
  const [sizeLabel, setSizeLabel] = useState('Custom')
  const deleteModel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/custom-models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })
  const addModel = useMutation({
    mutationFn: (body: { providerSlug: string; fields: Record<string, unknown> }) =>
      apiFetch(`/api/custom-providers/${body.providerSlug}/models`, {
        method: 'POST',
        body: JSON.stringify(body.fields),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setModelId('')
      setDisplayName('')
    },
  })
  const syncAll = useMutation({
    mutationFn: () => apiFetch<{
      fetched: number
      providers: number
      errors: { slug: string; error: string }[]
      added_by_provider: Record<string, string[]>
    }>(
      '/api/models/sync-all',
      { method: 'POST' },
    ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })

      const providers = Object.keys(data.added_by_provider)
      const allAdded = providers.flatMap(s => data.added_by_provider[s])

      if (allAdded.length > 0) {
        // Group-by-provider summary in the description (e.g. "openrouter: 3, nvidia: 1")
        // and the full per-model list in `details` so clicking the toast expands it.
        const summary = providers
          .map(slug => `${slug}: ${data.added_by_provider[slug].length}`)
          .join(' · ')
        addToast({
          kind: 'success',
          title: `Discovered ${allAdded.length} new model${allAdded.length === 1 ? '' : 's'}`,
          description: summary,
          details: providers.flatMap(slug =>
            data.added_by_provider[slug].map(mid => `${slug}/${mid}`),
          ),
          sticky: true,
        })
      }

      if (data.errors.length > 0) {
        // Each provider failure is its own toast so one bad slug doesn't bury
        // the rest. The detail list contains the slug + reason text.
        const slugs = data.errors.map(e => e.slug).join(', ')
        console.warn(`Model sync errors on: ${slugs}`, data.errors)
        addToast({
          kind: 'warning',
          title: `Model sync failed for ${data.errors.length} provider${data.errors.length === 1 ? '' : 's'}`,
          description: `Affected: ${slugs}`,
          details: data.errors.map(e => `${e.slug}: ${e.error}`),
        })
      }
    },
  })
  const [autoSync, setAutoSync] = useState(() => {
    try { return localStorage.getItem('auto-discover-models') === 'true' } catch { return false }
  })
  const toggleAutoSync = (v: boolean) => {
    setAutoSync(v)
    try { localStorage.setItem('auto-discover-models', String(v)) } catch { /* ignore */ }
  }
  // Keep the latest mutation object in a ref so the auto-sync interval below
  // can read `isPending`/`mutate` without listing `syncAll` as an effect
  // dependency — otherwise the 5-minute timer would be torn down and rebuilt
  // on every isPending flip (i.e. on every sync).
  const syncAllRef = useRef(syncAll)
  useEffect(() => {
    syncAllRef.current = syncAll
  })
  // Auto-sync every 5 minutes when enabled. Depends only on `autoSync` so the
  // interval stays stable across sync-triggered re-renders.
  useEffect(() => {
    if (!autoSync) return
    const id = setInterval(() => {
      if (!syncAllRef.current.isPending) syncAllRef.current.mutate()
    }, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [autoSync])
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!provider || !modelId || !displayName) return
    const fields: Record<string, unknown> = {
      modelId: modelId.trim(),
      displayName: displayName.trim(),
      contextWindow: contextWindow || null,
      maxOutputTokens: maxOutputTokens,
      supportsTools,
      supportsVision,
    }
    if (showAdvanced) {
      fields.intelligenceRank = intelligenceRank
      fields.speedRank = speedRank
      fields.sizeLabel = sizeLabel
    }
    addModel.mutate({ providerSlug: provider ?? '', fields })
  }
  // Count of registered models per platform — used to label the dropdown
  // entries so the user can see which providers already have models.
  const modelCountByPlatform = new Map<string, number>()
  for (const m of models) {
    modelCountByPlatform.set(m.platform, (modelCountByPlatform.get(m.platform) ?? 0) + 1)
  }
  const platformOptions: { value: string; label: string; sublabel: string }[] = [
    ...PLATFORMS.map(p => ({
      value: p.value as string,
      label: p.label,
      sublabel: `${modelCountByPlatform.get(p.value) ?? 0} models`,
    })),
    ...customProviders.filter(cp => !cp.archived).map(cp => ({
      value: cp.slug,
      label: `${cp.displayName} (custom)`,
      sublabel: `${modelCountByPlatform.get(cp.slug) ?? 0} models`,
    })),
  ]
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-medium">Models</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Register a model on a built-in provider (e.g. an unlisted Cerebras model) or on one of your
            custom platforms. The new model joins the fallback chain at the lowest priority — reorder in
            the Fallback tab.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
            <Switch checked={autoSync} onCheckedChange={toggleAutoSync} />
            Auto-discover
          </label>
          <Button variant="outline" size="sm" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
            {syncAll.isPending ? 'Discovering…' : 'Discover Models'}
          </Button>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-3 rounded-3xl border p-4 bg-card">
        <div className="space-y-1.5">
          <Label className="text-xs">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {platformOptions.map(p => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Model id</Label>
            <Input
              value={modelId}
              onChange={e => setModelId(e.target.value)}
              placeholder={provider ? `the model id your endpoint expects` : 'pick a provider first'}
              className="font-mono text-xs"
              disabled={!provider}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="human-readable label"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Context window (tokens)</Label>
            <Input
              type="number"
              min={0}
              value={contextWindow}
              onChange={e => setContextWindow(parseInt(e.target.value, 10) || 0)}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Max output tokens</Label>
            <Input
              type="number"
              min={0}
              value={maxOutputTokens ?? ''}
              onChange={e => { const v = parseInt(e.target.value, 10); setMaxOutputTokens(v > 0 ? v : null) }}
              placeholder="no limit"
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="flex items-center gap-6 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <Switch checked={supportsTools} onCheckedChange={setSupportsTools} />
            Supports tools
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <Switch checked={supportsVision} onCheckedChange={setSupportsVision} />
            Supports vision
          </label>
        </div>
        <button
          type="button"
          onClick={() => setShowAdvanced(s => !s)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div className="space-y-3 pt-1 border-t">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Intelligence rank (1-100)</Label>
                <Input type="number" min={1} max={100} value={intelligenceRank}
                  onChange={e => setIntelligenceRank(parseInt(e.target.value, 10) || 50)}
                  className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Speed rank (1-100)</Label>
                <Input type="number" min={1} max={100} value={speedRank}
                  onChange={e => setSpeedRank(parseInt(e.target.value, 10) || 50)}
                  className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Size label</Label>
                <Input value={sizeLabel} onChange={e => setSizeLabel(e.target.value)} className="font-mono text-xs" />
              </div>
            </div>
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button type="submit" size="sm" disabled={!provider || !modelId || !displayName || addModel.isPending}>
            {addModel.isPending ? 'Adding…' : 'Add model'}
          </Button>
        </div>
        {addModel.isError && (
          <p className="text-destructive text-xs">{(addModel.error as Error).message}</p>
        )}
      </form>
      {/* List existing custom models with archive buttons */}
      {models.filter(m => activeCustom.some(cp => cp.slug === m.platform)).length > 0 && (
        <div className="mt-3 rounded-2xl border divide-y bg-card overflow-hidden max-h-64 overflow-y-auto">
          {models
            .filter(m => activeCustom.some(cp => cp.slug === m.platform))
            .map(m => (
              <div key={m.id} className="flex items-center gap-2 px-4 py-2 hover:bg-muted/40 transition-colors">
                <code className="text-xs font-mono">{m.modelId}</code>
                <span className="text-xs text-muted-foreground">{m.displayName}</span>
                <span className={`ml-auto text-[11px] ${m.enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                  {m.enabled ? 'active' : 'archived'}
                </span>
                <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive"
                  onClick={() => setArchiveModelTarget({ id: m.id, modelId: m.modelId })}
                  disabled={!m.enabled || deleteModel.isPending}>
                  Archive
                </Button>
              </div>
            ))}
        </div>
      )}
      <ConfirmDialog
        open={archiveModelTarget !== null}
        onOpenChange={(open) => { if (!open) setArchiveModelTarget(null) }}
        title={`Archive model '${archiveModelTarget?.modelId ?? ''}'?`}
        description="The model leaves routing and the fallback chain. Re-add it to restore."
        confirmLabel="Archive"
        pending={deleteModel.isPending}
        onConfirm={() => { if (archiveModelTarget) deleteModel.mutate(archiveModelTarget.id); setArchiveModelTarget(null) }}
      />
     </section>
   )
 }

// Main Keys page. Renders the unified key section, the platform grid, the
// add-key form (which now lists custom slugs too), the per-platform key
// list, and the add-model form.
export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [accountIdMissing, setAccountIdMissing] = useState(false)
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editingProviderSlug, setEditingProviderSlug] = useState<string | null>(null)
  // L61: archive is destructive (removes provider + its models) — confirmed
  // via ConfirmDialog like every other destructive action on this page.
  const [archiveTarget, setArchiveTarget] = useState<{ slug: string; label: string } | null>(null)
  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })
  const { data: customProviders = [] } = useQuery<CustomProvider[]>({
    queryKey: ['custom-providers'],
    queryFn: () => apiFetch('/api/custom-providers'),
  })
  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
      setAccountIdMissing(false)
    },
  })
  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })
  const deleteProvider = useMutation({
    mutationFn: (slug: string) => apiFetch(`/api/custom-providers/${slug}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })
  const restoreProvider = useMutation({
    mutationFn: (slug: string) => {
      const cp = archivedCustom.find(c => c.slug === slug)
      return apiFetch('/api/custom-providers', {
        method: 'POST',
        body: JSON.stringify({ slug, displayName: cp?.displayName || slug, baseUrl: cp?.baseUrl || '' }),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })
  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['health'] }),
  })
  // Live progress for the "Check all" button. The previous version of this
  // button just sat on "Checking…" for 15+ minutes on a 89-key fleet with
  // zero feedback. Now we subscribe to the SSE /api/events stream and
  // update a progress counter as each key resolves. The operator sees
  // a live bar fill up + a per-key status flash as it happens.
  const [checkProgress, setCheckProgress] = useState<{ completed: number; total: number } | null>(null)
  // Throttle health invalidation during check-all: at most once per second
  // during progress events, plus once on done. Without this, a large fleet
  // triggers ~N invalidations (one per key), causing a refetch storm.
  const lastHealthInvalidate = useRef(0)
  // The reset timer below fires ~1.5s after 'health.check.done'; guard it so
  // it never touches state once the page has unmounted.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  useEventStream((e) => {
    if (e?.type === 'health.check.start') {
      setCheckProgress({ completed: 0, total: e.total as number })
    } else if (e?.type === 'health.check.progress') {
      setCheckProgress({ completed: e.completed as number, total: e.total as number })
      const now = Date.now()
      if (now - lastHealthInvalidate.current >= 1000) {
        lastHealthInvalidate.current = now
        queryClient.invalidateQueries({ queryKey: ['health'] })
      }
    } else if (e?.type === 'health.check.done') {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      lastHealthInvalidate.current = Date.now()
      window.setTimeout(() => { if (mountedRef.current) setCheckProgress(null) }, 1500)
    }
  }, checkAll.isPending)
  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${platform}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })
  const updateKey = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      setEditingKeyId(null)
      setEditingLabel('')
    },
  })
  function startEditing(key: ApiKey) {
    setEditingKeyId(key.id)
    setEditingLabel(key.label)
  }
  function cancelEditing() {
    setEditingKeyId(null)
    setEditingLabel('')
  }
  function saveEditing(id: number) {
    if (editingKeyId === null) return;
    updateKey.mutate({ id, label: editingLabel });
  }
  useEffect(() => {
    if (editingKeyId !== null && editInputRef.current) {
      editInputRef.current.focus()
    }
  }, [editingKeyId])
  // Split custom providers so archived ones don't clutter the main list.
  const activeCustom = customProviders.filter(cp => !cp.archived)
  const archivedCustom = customProviders.filter(cp => cp.archived)

  // Build a unified platform list for the add-key form. Built-ins come
  // first; active user-added custom providers appear at the end.
  const allPlatforms: { value: string; label: string; url: string; keyless?: boolean; keyFormat?: string }[] = [
    ...PLATFORMS,
    ...activeCustom.map(cp => ({ value: cp.slug, label: `${cp.displayName} (custom)`, url: '', keyless: cp.keyless, keyFormat: cp.keyFormat })),
  ]
  const selectedPlatform = allPlatforms.find(p => p.value === platform)
  const needsAccountId = platform === 'cloudflare' || selectedPlatform?.keyFormat === 'colon'
  const isKeyless = selectedPlatform?.keyless === true
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform) return
    if (!isKeyless && !apiKey) return
    if (needsAccountId && !accountId.trim()) { setAccountIdMissing(true); return }
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined })
  }
  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)
  // The "Configured providers" list groups by platform string. PLATFORMS
  // only seeds the header label; any platform string on a key (built-in
  // or custom) gets its own group.
  const grouped = allPlatforms
    .map(p => ({ ...p, keys: keys.filter(k => k.platform === p.value) }))
    .filter(p => p.keys.length > 0)
  const editingProvider: {
    kind: 'custom' | 'built-in';
    slug: string;
    provider?: CustomProvider;
    builtInSettings?: BuiltInProviderSettings;
  } | null = editingProviderSlug
    ? (() => {
        const cp = customProviders.find(p => p.slug === editingProviderSlug);
        if (cp) return { kind: 'custom' as const, slug: editingProviderSlug, provider: cp };
        if (PLATFORMS_SLUGS.has(editingProviderSlug)) {
          return { kind: 'built-in' as const, slug: editingProviderSlug };
        }
        return null;
      })()
    : null;
  // Shared per-key row used by both active groups and the archived-providers
  // section so their look and actions stay identical.
  const renderKeyRow = (k: ApiKey) => {
    const h = healthKeyMap.get(k.id)
    const status = h?.status ?? k.status
    const lastChecked = h?.lastCheckedAt
    const isEditing = editingKeyId === k.id
    return (
      <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
        <span className={`size-1.5 rounded-full shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
        <code className="text-xs font-mono shrink-0">{k.maskedKey}</code>
        {isEditing ? (
          <Input
            ref={editInputRef}
            value={editingLabel}
            onChange={e => setEditingLabel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { setEditingKeyId(null); saveEditing(k.id); }
              if (e.key === 'Escape') cancelEditing()
            }}
            onBlur={() => saveEditing(k.id)}
            className="h-6 w-[160px] text-xs"
            disabled={updateKey.isPending}
          />
        ) : (
          <>{k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}</>
        )}
        <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
        <div className="flex-1" />
        {lastChecked && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {formatSqliteUtcToLocalTime(lastChecked, { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {!isEditing && (
          <Button variant="ghost" size="xs" onClick={() => startEditing(k)}>
            <Pencil className="size-3" />
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending && checkKey.variables === k.id}>
          Check
        </Button>
        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending && deleteKey.variables === k.id}>
          Remove
        </Button>
      </div>
    )
  }
  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          keys.length > 0 && (
            <div className="flex items-center gap-3">
              {checkProgress && (
                // Live progress bar shown while checkAll is running.
                // Renders "Checking 12/89…" with a thin filled bar
                // so the operator can see something IS happening instead
                // of a frozen "Checking…" spinner.
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="w-32 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-[width] duration-150"
                      style={{ width: `${checkProgress.total > 0 ? Math.min(100, (checkProgress.completed / checkProgress.total) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="font-mono tabular-nums">{checkProgress.completed}/{checkProgress.total}</span>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setCheckProgress(null); checkAll.mutate() }}
                disabled={checkAll.isPending}
              >
                {checkAll.isPending ? 'Checking…' : 'Check all'}
              </Button>
            </div>
          )
        }
      />
      <div className="space-y-8">
        <UnifiedKeySection />
        <ClientKeysSection />
        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 rounded-3xl border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={val => {
                if (val === '__add_new_platform__') { setAddOpen(true); return }
                setPlatform(val)
              }}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                  {customProviders.length > 0 && (
                    <>
                      <SelectItem value="__divider" disabled className="text-muted-foreground">— custom —</SelectItem>
                      {customProviders.map(cp => (
                        <SelectItem key={cp.slug} value={cp.slug}>{cp.displayName} (custom)</SelectItem>
                      ))}
                    </>
                  )}
                  <SelectItem value="__add_new_platform__" className="border-t font-semibold text-muted-foreground italic">
                    <Plus className="size-4 inline mr-1" />Add New Platform
                  </SelectItem>
                </SelectContent>
              </Select>
              {selectedPlatform?.url && (
                <div className="pt-0.5"><GetKeyLink url={selectedPlatform.url} /></div>
              )}
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Account ID</Label>
                <Input
                  value={accountId}
                  onChange={e => { setAccountId(e.target.value); setAccountIdMissing(false) }}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
                {accountIdMissing && (
                  <p className="text-[11px] text-destructive">Account ID is required for this provider.</p>
                )}
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input
                type="password"
                value={isKeyless ? '' : apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={isKeyless ? 'No API key needed' : (needsAccountId ? 'Bearer token' : 'paste key here')}
                className="font-mono text-xs"
                disabled={isKeyless}
              />
              {isKeyless && (
                <p className="text-[11px] text-muted-foreground">
                  No API key needed: this provider's free tier is anonymous (rate-limited per IP).
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. My production key"
                  className="w-[160px]"
                />
                <Button type="submit" size="sm" disabled={addKey.isPending || (!isKeyless && (!platform || !apiKey)) || (needsAccountId && !accountId.trim())}>
                  {isKeyless ? 'Enable' : addKey.isPending ? 'Adding…' : 'Add key'}
                </Button>
              </div>
            </div>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>
        <CustomModelsSection />
        <section>
          <h2 className="text-sm font-medium mb-3">Configured keys</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : grouped.length === 0 ? (
            <div className="rounded-3xl border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => {
                // L63: a group where SOME keys are on must not render its
                // master toggle as fully ON. Base UI's Switch has no
                // indeterminate state, so the mixed case gets a distinct
                // partial appearance (half-width thumb, amber track) while
                // the all-on/all-off cases keep the regular toggle look.
                const enabledCount = group.keys.filter(k => k.enabled).length
                const allOn = enabledCount === group.keys.length
                const partial = enabledCount > 0 && enabledCount < group.keys.length
                return (
                <div key={group.value}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={allOn}
                        data-partial={partial || undefined}
                        onCheckedChange={(c) => togglePlatform.mutate({ platform: group.value, enabled: c })}
                        disabled={togglePlatform.isPending}
                        className={cn(
                          partial && "data-[partial]:bg-amber-500/60 data-[partial]:data-unchecked:bg-amber-500/60",
                        )}
                        aria-label={`Toggle all ${group.label} keys`}
                      />
                      <h3 className="text-sm font-medium">{group.label}</h3>
                      <GetKeyLink url={group.url} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                      </span>
                      {(customProviders.some(cp => cp.slug === group.value) || PLATFORMS_SLUGS.has(group.value)) && (
                        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground"
                          onClick={() => setEditingProviderSlug(group.value)}>
                          Edit
                        </Button>
                      )}
                      {customProviders.some(cp => cp.slug === group.value) && (
                        <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive"
                        onClick={() => setArchiveTarget({ slug: group.value, label: group.label })}
                          disabled={deleteProvider.isPending}>
                          Archive
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="rounded-2xl border divide-y bg-card overflow-hidden">
                    {group.keys.map(renderKeyRow)}
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </section>
        {archivedCustom.length > 0 && (
          <section>
            <h2 className="text-sm font-medium mb-2 text-muted-foreground">Archived providers</h2>
            <div className="rounded-2xl border divide-y bg-card overflow-hidden">
              {archivedCustom.map(cp => {
                // Keys on archived providers stay listed here so they can
                // still be audited or removed; Restore re-enables the
                // provider and returns its keys to the main list.
                const cpKeys = keys.filter(k => k.platform === cp.slug)
                return (
                  <div key={cp.slug} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-muted-foreground">{cp.displayName}</p>
                        <p className="text-[11px] text-muted-foreground font-mono">{cp.slug}</p>
                      </div>
                      {cpKeys.length > 0 && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {cpKeys.length} key{cpKeys.length === 1 ? '' : 's'}
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => restoreProvider.mutate(cp.slug)}
                        disabled={restoreProvider.isPending}
                      >
                        {restoreProvider.isPending ? 'Restoring…' : 'Restore'}
                      </Button>
                    </div>
                    {cpKeys.length > 0 && (
                      <div className="mt-2 rounded-xl border divide-y overflow-hidden">
                        {cpKeys.map(renderKeyRow)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
      <AddPlatformModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => setAddOpen(false)}
      />
      {editingProvider && (
        <EditPlatformModal
          slug={editingProviderSlug!}
          kind={editingProvider.kind}
          provider={editingProvider.provider}
          onClose={() => setEditingProviderSlug(null)}
          onSaved={() => setEditingProviderSlug(null)}
        />
      )}
      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}
        title={`Archive provider '${archiveTarget?.label ?? ''}'?`}
        description="Archiving removes the provider and all its models. It can be undone by re-adding the provider."
        confirmLabel="Archive"
        pending={deleteProvider.isPending}
        onConfirm={() => { if (archiveTarget) deleteProvider.mutate(archiveTarget.slug); setArchiveTarget(null) }}
      />
     </div>
   )
 }