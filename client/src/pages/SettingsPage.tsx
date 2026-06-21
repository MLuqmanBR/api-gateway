// Settings page. Currently holds the configuration export / import
// workflow. Wired into the navbar at /settings.
//
// The page is intentionally thin: a section picker, a passphrase field,
// and an Export button up top; an Import card with file picker, mode
// radio, passphrase field, dry-run toggle, and an Apply button below.
// The Import card shows a diff summary after preview/dry-run so the user
// can see what will change before committing.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Download,
  Upload,
  ShieldAlert,
  CheckCircle2,
  FileJson,
  KeyRound,
  Eye,
  EyeOff,
  Loader2,
  AlertTriangle,
  Clipboard,
  Check,
  X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { addToast } from '@/lib/toast'
import { makeConfigBackupFilename, getLocalTimezoneName, downloadBlob } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import type {
  ConfigEnvelope,
  ConfigSection,
  ConfigImportSummary,
  ConfigKeyCompatibility,
  ConfigMergeMode,
} from '../../../shared/types'

// All exportable sections, in the order they're presented in the UI.
const SECTIONS: { value: ConfigSection; label: string; description: string }[] = [
  { value: 'models', label: 'Models', description: 'Catalog rows, ranks, limits, capabilities.' },
  { value: 'fallback_chain', label: 'Fallback chain', description: 'Order + enabled state of every model.' },
  { value: 'custom_providers', label: 'Custom providers', description: 'OpenAI-compatible endpoints you registered.' },
  { value: 'api_keys', label: 'API keys', description: 'Encrypted at rest; plaintext if no passphrase.' },
  { value: 'embeddings', label: 'Embeddings', description: 'Family configuration + default family.' },
  { value: 'settings', label: 'Routing settings', description: 'Strategy, retry limit, custom weights.' },
  { value: 'quirks', label: 'Quirks', description: 'Provider/model notes you authored.' },
]

type Inventory = Record<ConfigSection, number>



export default function SettingsPage() {
  const queryClient = useQueryClient()
  const inventory = useQuery<Inventory>({
    queryKey: ['config-inventory'],
    queryFn: () => apiFetch<Inventory>('/api/config/inventory'),
  })

  // ── Export state ─────────────────────────────────────────────────────
  const [exportSections, setExportSections] = useState<Record<ConfigSection, boolean>>({
    models: true,
    fallback_chain: true,
    custom_providers: true,
    api_keys: true,
    embeddings: true,
    settings: true,
    quirks: true,
  })
  const [exportPassphrase, setExportPassphrase] = useState('')
  const [exportLabel, setExportLabel] = useState('')
  const [showExportPassphrase, setShowExportPassphrase] = useState(false)

  const sectionsParam = useMemo<ConfigSection[]>(() => {
    const out: ConfigSection[] = []
    for (const s of SECTIONS) if (exportSections[s.value]) out.push(s.value)
    return out
  }, [exportSections])

  // ── Import state ─────────────────────────────────────────────────────
  const [importEnvelope, setImportEnvelope] = useState<unknown>(null)
  const [importFileName, setImportFileName] = useState<string | null>(null)
  const [importMode, setImportMode] = useState<ConfigMergeMode>('skip-existing')
  const [importDryRun, setImportDryRun] = useState(true)
  const [importPassphrase, setImportPassphrase] = useState('')
  const [showImportPassphrase, setShowImportPassphrase] = useState(false)
  const [preview, setPreview] = useState<
    | { ok: true; sections: Record<ConfigSection, number>; hasKeysCipher: boolean; label?: string; exportedAt: string; schemaVersion: number; keyCompatibility: ConfigKeyCompatibility }
    | { ok: false; error: string }
    | null
  >(null);
  const [dryRunResult, setDryRunResult] = useState<ConfigImportSummary | null>(null)

  // Reset any stale state when the file picker changes.
  const fileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => {
    // Free any object URLs we created when the component unmounts.
    if (fileInputRef.current?.value) fileInputRef.current.value = ''
  }, [])

  // ── Mutations ────────────────────────────────────────────────────────
  // The export mutation can either save the file or stash the envelope in
  // a state variable so the "Preview in browser" modal can render it.
  // That state is shared with the modal below.
  const [previewEnvelope, setPreviewEnvelope] = useState<ConfigEnvelope | null>(null)
  const exportMutation = useMutation({
    mutationFn: async (opts: { download: boolean }) => {
      const res = await fetch(buildUrl('/api/config/export'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          sections: sectionsParam,
          passphrase: exportPassphrase || undefined,
          label: exportLabel.trim() || undefined,
          download: opts.download,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
        throw new Error(err.error?.message ?? `HTTP ${res.status}`)
      }
      const text = await res.text()
      let envelope: ConfigEnvelope | null = null
      try { envelope = JSON.parse(text) as ConfigEnvelope } catch { /* keep null */ }
      // The client is the source of truth for the filename. The server
      // doesn't know the user's timezone, so it always emits a UTC
      // stamp; the client must use the browser's local time. We
      // always generate a fresh local-time filename here rather than
      // trusting the server's `Content-Disposition`, which would
      // show a UTC timestamp and confuse the user. The optional
      // label ("Laptop staging" / "Production") is folded into the
      // filename so multiple exports can be told apart at a glance.
      const trimmedLabel = exportLabel.trim();
      const localFilename = makeConfigBackupFilename(new Date(), trimmedLabel || undefined);
      return { res, body: text, envelope, filename: localFilename, localFilename }
    },
    onSuccess: ({ body, filename, envelope }, vars) => {
      if (vars.download) {
        downloadBlob(filename, new Blob([body], { type: 'application/json' }))
        addToast({ kind: 'success', title: 'Configuration exported', sticky: false })
      } else if (envelope) {
        setPreviewEnvelope(envelope)
      } else {
        addToast({ kind: 'warning', title: 'Preview not available', description: 'Server returned a non-JSON response.', sticky: false })
      }
    },
    onError: (e: Error) => {
      addToast({ kind: 'warning', title: 'Export failed', description: e.message, sticky: false })
    },
  })

  const previewMutation = useMutation({
    mutationFn: async () => {
      return apiFetch<{
        sections: Record<ConfigSection, number>
        hasKeysCipher: boolean
        label?: string
        exportedAt: string
        schemaVersion: number
        keyCompatibility: ConfigKeyCompatibility
      }>('/api/config/preview', {
        method: 'POST',
        body: JSON.stringify(importEnvelope),
      })
    },
    onSuccess: (data) => {
      setPreview({ ok: true, ...data })
      setDryRunResult(null)
    },
    onError: (e: Error) => {
      setPreview({ ok: false, error: e.message })
      setDryRunResult(null)
    },
  })

  const importMutation = useMutation({
    mutationFn: async (opts: { dryRun: boolean }) => {
      return apiFetch<ConfigImportSummary>('/api/config/import', {
        method: 'POST',
        body: JSON.stringify({
          envelope: importEnvelope,
          options: {
            mode: importMode,
            dryRun: opts.dryRun,
            passphrase: importPassphrase || undefined,
          },
        }),
      })
    },
    onSuccess: (data, vars) => {
      if (vars.dryRun) {
        setDryRunResult(data)
        return
      }
      const totalAdded = Object.values(data.sections).reduce((n, s) => n + s.added, 0)
      const totalUpdated = Object.values(data.sections).reduce((n, s) => n + s.updated, 0)
      addToast({
        kind: 'success',
        title: 'Configuration imported',
        description: `Added ${totalAdded}, updated ${totalUpdated} across ${Object.keys(data.sections).length} sections.`,
        sticky: false,
      })
      setDryRunResult(null)
      setImportEnvelope(null)
      setImportFileName(null)
      setPreview(null)
      // Refetch everything that might have changed. Use a coarse key prefix
      // set since we don't know which exact queries are affected.
      queryClient.invalidateQueries({ queryKey: ['config-inventory'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['custom-providers'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['routing'] })
    },
    onError: (e: Error) => {
      addToast({ kind: 'warning', title: 'Import failed', description: e.message, sticky: true })
    },
  })

  // ── Handlers ─────────────────────────────────────────────────────────
  async function onFileSelected(file: File) {
    setImportFileName(file.name)
    setPreview(null)
    setDryRunResult(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      setImportEnvelope(parsed)
    } catch (e) {
      setImportEnvelope(null)
      addToast({ kind: 'warning', title: 'Invalid JSON file', description: (e as Error).message, sticky: false })
    }
  }

  function toggleSection(value: ConfigSection) {
    setExportSections((cur) => ({ ...cur, [value]: !cur[value] }))
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Back up your full configuration to a single file, or restore from one. Models, custom providers, keys, limits, and routing all travel together."
      />

      <div className="space-y-6">
        {/* ── Inventory ─────────────────────────────────────────────── */}
        <Card size="sm">
          <CardHeader>
            <CardTitle>Current configuration</CardTitle>
            <CardDescription>What's stored right now and will travel in an export.</CardDescription>
          </CardHeader>
          <CardContent>
            {inventory.isError ? (
              <p className="text-xs text-destructive">Can't reach the server.</p>
            ) : !inventory.data ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
                {SECTIONS.map((s) => (
                  <div key={s.value} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{s.label}</dt>
                    <dd className="font-mono tabular-nums">{inventory.data[s.value]}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>

        {/* ── Export ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="size-4" /> Export configuration
            </CardTitle>
            <CardDescription>Save the current setup to a portable JSON file. Optionally protect API keys with a passphrase.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground mb-2 block">
                Sections to include
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SECTIONS.map((s) => (
                  <label key={s.value} className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-accent/40 transition-colors">
                    <Switch
                      checked={exportSections[s.value]}
                      onCheckedChange={() => toggleSection(s.value)}
                      size="sm"
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{s.label}</div>
                      <div className="text-xs text-muted-foreground">{s.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="export-label" className="text-xs">Label (optional)</Label>
                <Input
                  id="export-label"
                  placeholder="e.g. Laptop staging"
                  value={exportLabel}
                  onChange={(e) => setExportLabel(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div>
                <Label htmlFor="export-passphrase" className="text-xs flex items-center gap-1">
                  <KeyRound className="size-3" /> Passphrase (optional, recommended)
                </Label>
                <div className="relative">
                  <Input
                    id="export-passphrase"
                    type={showExportPassphrase ? 'text' : 'password'}
                    placeholder="Encrypts the api_keys section"
                    value={exportPassphrase}
                    onChange={(e) => setExportPassphrase(e.target.value)}
                    autoComplete="off"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowExportPassphrase((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showExportPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                  >
                    {showExportPassphrase ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                {exportSections.api_keys && exportPassphrase.length === 0 && (
                  <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-1.5">
                    <AlertTriangle className="size-3 mt-0.5 shrink-0" />
                    <div>
                      Without a passphrase, this backup can only be restored on a gateway using the same
                      <code className="font-mono mx-1">ENCRYPTION_KEY</code>. Add a passphrase if you're moving the
                      file between machines.
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => exportMutation.mutate({ download: true })}
                disabled={exportMutation.isPending || sectionsParam.length === 0}
              >
                {exportMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                Download JSON file
              </Button>
              <Button
                variant="outline"
                onClick={() => exportMutation.mutate({ download: false })}
                disabled={exportMutation.isPending || sectionsParam.length === 0}
              >
                <FileJson className="size-4" />
                Preview in browser
              </Button>
              <span className="text-xs text-muted-foreground">
                Always run a dry-run first when applying against a populated database.
              </span>
            </div>
          </CardContent>
        </Card>

        {/* ── Import ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="size-4" /> Import configuration
            </CardTitle>
            <CardDescription>Restore from a previously exported file. Use dry-run to preview before committing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="import-file" className="text-xs">Configuration file</Label>
              <Input
                id="import-file"
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) onFileSelected(file)
                }}
              />
              {importFileName && (
                <div className="text-xs text-muted-foreground mt-1">
                  Loaded: <code className="font-mono">{importFileName}</code>
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <fieldset className="rounded-lg border p-3">
                <legend className="text-xs uppercase tracking-wide text-muted-foreground px-1">Merge mode</legend>
                <div className="flex flex-col gap-2 mt-1">
                  {([
                    { v: 'skip-existing', label: 'Skip existing', help: 'Never touch rows that already exist. Safest default.' },
                    { v: 'overwrite', label: 'Overwrite', help: 'Update existing rows in place, add the rest.' },
                    { v: 'replace', label: 'Replace', help: 'Wipe the destination section, then insert from the file.' },
                  ] as const).map((opt) => (
                    <label key={opt.v} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="merge-mode"
                        value={opt.v}
                        checked={importMode === opt.v}
                        onChange={() => setImportMode(opt.v)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-sm font-medium">{opt.label}</span>
                        <span className="block text-xs text-muted-foreground">{opt.help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Dry run first</Label>
                  <Switch
                    checked={importDryRun}
                    onCheckedChange={(v) => setImportDryRun(v === true)}
                    size="sm"
                  />
                </div>
                <div>
                  <Label htmlFor="import-passphrase" className="text-xs flex items-center gap-1">
                    <KeyRound className="size-3" /> Passphrase (if file is encrypted)
                  </Label>
                  <div className="relative">
                    <Input
                      id="import-passphrase"
                      type={showImportPassphrase ? 'text' : 'password'}
                      placeholder="Required when envelope contains keysCipher"
                      value={importPassphrase}
                      onChange={(e) => setImportPassphrase(e.target.value)}
                      autoComplete="off"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowImportPassphrase((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={showImportPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                    >
                      {showImportPassphrase ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => previewMutation.mutate()}
                disabled={!importEnvelope || previewMutation.isPending}
              >
                {previewMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileJson className="size-4" />}
                Preview
              </Button>
              <Button
                onClick={() => importMutation.mutate({ dryRun: true })}
                disabled={!importEnvelope || importMutation.isPending}
              >
                {importMutation.isPending && importMutation.variables?.dryRun
                  ? <Loader2 className="size-4 animate-spin" />
                  : <Eye className="size-4" />}
                Run dry-run
              </Button>
              <Button
                variant="destructive"
                onClick={() => importMutation.mutate({ dryRun: false })}
                disabled={!importEnvelope || importMutation.isPending}
              >
                {importMutation.isPending && !importMutation.variables?.dryRun
                  ? <Loader2 className="size-4 animate-spin" />
                  : <ShieldAlert className="size-4" />}
                Apply import
              </Button>
              <span className="text-xs text-muted-foreground">
                Always run a dry-run first when applying against a populated database.
              </span>
            </div>

            {/* ── Preview result ─────────────────────────────────── */}
            {preview && !preview.ok && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5 inline-block mr-1" />
                {preview.error}
              </div>
            )}
            {preview && preview.ok && (
              <PreviewPanel
                sections={preview.sections}
                hasKeysCipher={preview.hasKeysCipher}
                keyCompatibility={preview.keyCompatibility}
                label={preview.label}
                exportedAt={preview.exportedAt}
                schemaVersion={preview.schemaVersion}
              />
            )}

            {/* ── Dry-run / commit result ────────────────────────── */}
            {dryRunResult && (
              <SummaryPanel summary={dryRunResult} dryRun />
            )}
          </CardContent>
        </Card>
      </div>
      {previewEnvelope && (
        <ExportPreviewModal
          envelope={previewEnvelope}
          onClose={() => setPreviewEnvelope(null)}
        />
      )}
    </div>
  )
}

// ── Export preview modal ────────────────────────────────────
// Shows the freshly-built envelope in a code block with copy and
// download actions. Triggered by the Export card's "Preview in
// browser" button.
function ExportPreviewModal({
  envelope,
  onClose,
}: {
  envelope: ConfigEnvelope
  onClose: () => void
}) {
  const pretty = useMemo(() => JSON.stringify(envelope, null, 2), [envelope])
  // The download button always uses a fresh local-time filename so the
  // user gets a consistent `API_Gateway-Backup-YYYY-MM-DD-HH-mm-ss.json`
  // regardless of where the modal was opened or whether the server
  // emitted a different Content-Disposition suggestion. The envelope's
  // optional `label` ("Laptop staging", "Production") is folded in
  // so the downloaded file's name matches what the operator saw in
  // the label field on the export card.
  const downloadName = useMemo(
    () => makeConfigBackupFilename(new Date(), envelope.label),
    [envelope.label],
  )
  const tz = useMemo(() => getLocalTimezoneName(), [])
  const sectionCounts = useMemo(() => {
    return {
      models: envelope.sections.models?.length ?? 0,
      fallback_chain: envelope.sections.fallbackChain?.length ?? 0,
      custom_providers: envelope.sections.customProviders?.length ?? 0,
      api_keys: envelope.sections.apiKeys?.length ?? 0,
      embeddings: envelope.sections.embeddings?.families.length ?? 0,
      settings: envelope.sections.settings ? 1 : 0,
      quirks: envelope.sections.quirks?.length ?? 0,
    } as Record<ConfigSection, number>
  }, [envelope])
  function download() {
    downloadBlob(downloadName, new Blob([pretty], { type: 'application/json' }))
  }

  // Copy-button feedback state. When the user clicks Copy, the button
  // label changes to "Copied" (or "Copy failed" on error) and is
  // disabled for `COPY_FEEDBACK_MS` so the operator gets immediate,
  // in-place confirmation in addition to the toast. The toast remains
  // for users who don't see the button (e.g. keyboard focus is
  // elsewhere, or they're using a screen reader).
  type CopyState = 'idle' | 'copied' | 'error'
  const COPY_FEEDBACK_MS = 1500
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current)
  }, [])
  function scheduleCopyReset(): void {
    if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => {
      setCopyState('idle')
      copyResetTimer.current = null
    }, COPY_FEEDBACK_MS)
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(pretty)
      setCopyState('copied')
      addToast({ kind: 'success', title: 'Envelope copied to clipboard', sticky: false })
    } catch (e) {
      setCopyState('error')
      addToast({ kind: 'warning', title: 'Copy failed', description: (e as Error).message, sticky: false })
    } finally {
      scheduleCopyReset()
    }
  }
  // The envelope's exportedAt is in UTC (ISO 8601). Render an equivalent
  // in the user's local time so the operator can sanity-check it against
  // the timezone named below.
  const localExportedAt = useMemo(() => {
    const d = new Date(envelope.exportedAt)
    if (isNaN(d.getTime())) return envelope.exportedAt
    return d.toLocaleString([], { hour12: false })
  }, [envelope.exportedAt])
  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] rounded-3xl border bg-card p-5 shadow-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3 gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Configuration preview</h3>
            <p className="text-xs text-muted-foreground mt-0.5 break-all">
              {downloadName} · schema v{envelope.schemaVersion} · your timezone: {tz}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5 break-all">
              exported {envelope.exportedAt} UTC · {localExportedAt} {tz}
            </p>
          </div>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close preview">
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mb-2">
          {Object.entries(sectionCounts).map(([name, n]) => (
            <span key={name} className="font-mono">
              <span className="text-foreground">{n}</span> {name}
            </span>
          ))}
          {envelope.keysCipher && (
            <span className="font-mono">
              <span className="text-foreground">1</span> keysCipher
            </span>
          )}
        </div>
        <pre className="flex-1 min-h-0 overflow-auto rounded-lg border bg-muted/30 p-3 text-[11px] font-mono leading-snug whitespace-pre-wrap break-all">
          {pretty}
        </pre>
        <div className="flex justify-end gap-2 mt-3">
          <Button
            variant="outline"
            onClick={copy}
            disabled={copyState !== 'idle'}
            aria-live="polite"
            className={copyState === 'copied' ? 'border-emerald-500/60 text-emerald-600 dark:text-emerald-400' : undefined}
          >
            {copyState === 'copied' ? <Check className="size-4" /> : <Clipboard className="size-4" />}
            {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
          </Button>
          <Button onClick={download}>
            <Download className="size-4" />
            Download
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildUrl(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  return `${base}${path}`
}

function authHeaders(): Record<string, string> {
  // Reuse the same auth token the apiFetch helper uses — direct fetch
  // skips the helper so we don't have to type the response as JSON.
  const token = localStorage.getItem('api-gateway_dashboard_token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// ── Sub-panels ─────────────────────────────────────────────────────────

function PreviewPanel({
  sections,
  hasKeysCipher,
  keyCompatibility,
  label,
  exportedAt,
  schemaVersion,
}: {
  sections: Record<ConfigSection, number>
  hasKeysCipher: boolean
  keyCompatibility: ConfigKeyCompatibility
  label?: string
  exportedAt: string
  schemaVersion: number
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="size-4 text-emerald-500" />
          <span className="font-medium">Envelope parsed successfully</span>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1">
          <Field label="Schema" value={`v${schemaVersion}`} />
          <Field label="Exported at" value={exportedAt} />
          {label && <Field label="Label" value={label} />}
          <Field label="Encrypted keys" value={hasKeysCipher ? 'yes (passphrase required)' : 'no'} />
        </dl>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1">
          {SECTIONS.map((s) => (
            <div key={s.value} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="font-mono tabular-nums">{sections[s.value]}</dd>
            </div>
          ))}
        </div>
      </div>
      <KeyCompatibilityBanner status={keyCompatibility} />
    </div>
  )
}
// Renders a context-sensitive banner explaining the api_keys compatibility
// verdict for an envelope — BEFORE the operator clicks Apply. Three tones:
//
//   - 'mismatch' (destructive / amber): the row ciphertext cannot decrypt
//     under this gateway's ENCRYPTION_KEY. Re-export with a passphrase
//     on the source machine to recover the keys.
//   - 'encrypted-with-passphrase' (info): the envelope is passphrase
//     protected; the operator must supply the passphrase at import time.
//   - 'plaintext' (info): keys are in plaintext in the file — fine for
//     offline backups, but the operator should treat the file accordingly.
//   - 'compatible' / 'no-keys': no banner needed.
function KeyCompatibilityBanner({ status }: { status: ConfigKeyCompatibility }) {
  if (status === 'compatible' || status === 'no-keys') return null;
  if (status === 'mismatch') {
    return (
      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
        <AlertTriangle className="size-4 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <div className="font-medium">These API keys were encrypted under a different gateway.</div>
          <div className="text-amber-800 dark:text-amber-300">
            The destination gateway's ENCRYPTION_KEY cannot decrypt these rows. Continuing will leave
            those keys unusable. To recover them, re-export this backup <strong>with a passphrase</strong>
            on the source machine and import the new file here.
          </div>
        </div>
      </div>
    );
  }
  if (status === 'encrypted-with-passphrase') {
    return (
      <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2.5 text-xs text-sky-900 dark:text-sky-200 flex items-start gap-2">
        <KeyRound className="size-4 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <div className="font-medium">Passphrase required.</div>
          <div className="text-sky-800 dark:text-sky-300">
            Enter the passphrase used at export time below — the api_keys section will be re-encrypted
            under this gateway's ENCRYPTION_KEY on import.
          </div>
        </div>
      </div>
    );
  }
  // 'plaintext'
  return (
    <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 shrink-0" />
      <div>
        API keys in this backup are stored in plaintext. Treat the file accordingly — anyone with
        the file can read the keys. Re-export with a passphrase for safer transport.
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground uppercase tracking-wide text-[10px]">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  )
}

function SummaryPanel({ summary, dryRun }: { summary: ConfigImportSummary; dryRun: boolean }) {
  const totals = Object.values(summary.sections).reduce(
    (acc, s) => ({
      added: acc.added + s.added,
      updated: acc.updated + s.updated,
      skipped: acc.skipped + s.skipped,
      errors: acc.errors + s.errors.length,
    }),
    { added: 0, updated: 0, skipped: 0, errors: 0 },
  )
  const showMismatchBanner =
    summary.keyCompatibility?.status === 'mismatch' ||
    // Fallback for older envelopes / future-proofing: surface the
    // banner whenever api_keys errors mention the canonical
    // "different ENCRYPTION_KEY" phrase, even if the structured
    // diagnostic is missing.
    (summary.sections.api_keys?.errors ?? []).some((e) =>
      /different ENCRYPTION_KEY than this gateway/.test(e),
    )
  return (
    <div className="space-y-3">
      {showMismatchBanner && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">
              {summary.keyCompatibility?.skippedDueToMismatch ?? (
                summary.sections.api_keys?.errors.length ?? 0
              )}{' '}
              key{summary.keyCompatibility?.skippedDueToMismatch === 1 ? '' : 's'} couldn't be restored
              because they were encrypted under a different ENCRYPTION_KEY.
            </div>
            <div className="text-amber-800 dark:text-amber-300">
              Re-export the source backup <strong>with a passphrase</strong> and re-import — the keys
              will then travel as a re-encrypted blob and decrypt cleanly on this gateway.
            </div>
            {summary.keyCompatibility?.sampleFailure && (
              <div className="text-amber-800 dark:text-amber-300 font-mono text-[11px] mt-1">
                e.g. <span className="font-sans">{summary.keyCompatibility.sampleFailure.platform}</span>
                {' / '}
                <span className="font-sans">{summary.keyCompatibility.sampleFailure.label}</span>
              </div>
            )}
          </div>
        </div>
      )}
      <div className={`rounded-lg border px-4 py-3 text-xs ${dryRun ? 'bg-muted/40' : 'bg-emerald-500/5 border-emerald-500/40'}`}>
        <div className="flex items-center gap-2 mb-2">
          {dryRun
            ? <Eye className="size-4 text-muted-foreground" />
            : <CheckCircle2 className="size-4 text-emerald-500" />}
          <span className="font-medium">
            {dryRun ? 'Dry-run diff (no changes committed)' : 'Import committed'}
          </span>
          <span className="ml-auto text-muted-foreground">{summary.mode}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 mb-3">
          <Counter label="Added" value={totals.added} />
          <Counter label="Updated" value={totals.updated} />
          <Counter label="Skipped" value={totals.skipped} />
          <Counter label="Errors" value={totals.errors} muted={totals.errors === 0} />
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              <th className="py-1 font-normal">Section</th>
              <th className="py-1 font-normal text-right">Added</th>
              <th className="py-1 font-normal text-right">Updated</th>
              <th className="py-1 font-normal text-right">Skipped</th>
              <th className="py-1 font-normal text-right">Errors</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {Object.entries(summary.sections).map(([name, s]) => (
              <tr key={name} className="border-t border-border/50">
                <td className="py-1 font-sans">{name}</td>
                <td className="py-1 text-right">{s.added}</td>
                <td className="py-1 text-right">{s.updated}</td>
                <td className="py-1 text-right">{s.skipped}</td>
                <td className={`py-1 text-right ${s.errors.length > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {s.errors.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {totals.errors > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-muted-foreground">Show error details</summary>
            <ul className="mt-2 space-y-1 text-destructive">
              {Object.entries(summary.sections).flatMap(([name, s]) =>
                s.errors.map((msg, i) => (
                  <li key={`${name}-${i}`}><code className="font-mono">{name}</code>: {msg}</li>
                )),
              )}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}

function Counter({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground uppercase tracking-wide text-[10px]">{label}</span>
      <span className={`font-mono ${muted ? 'text-muted-foreground' : ''}`}>{value}</span>
    </div>
  )
}
