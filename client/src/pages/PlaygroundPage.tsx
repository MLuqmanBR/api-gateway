import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'
import { addToast } from '@/lib/toast'
import { Paperclip } from 'lucide-react'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

/** A file the user attached to their turn. */
interface Attachment {
  kind: 'image' | 'audio' | 'video'
  dataUrl: string
  name: string
}

interface ChatMessage {
  /** Stable identity for React keys — the list mutates while streaming. */
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
    streaming?: boolean
  }
}

// Shape of an OpenAI-style error envelope returned by the proxy on a non-2xx.
interface ErrorBody {
  error?: { type?: string; message?: string }
}

// Minimal shape of a streaming chat-completion SSE frame we read from.
interface StreamChunk {
  error?: { message?: string }
  choices?: { delta?: { content?: string } }[]
}

// Request body sent to /v1/chat/completions from the playground.
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'video_url'; video_url: { url: string } }

interface ChatRequestBody {
  messages: { role: string; content: string | ContentPart[] }[]
  stream: boolean
  model?: string
}

/** Max attachment size. Base64 inflates by ~4/3, so 15 MB stays well under the
 *  server's 64 MB /v1 body limit even with several attachments. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

/** Map a file's MIME type to the modality the gateway routes on. */
function attachmentKind(file: File): Attachment['kind'] | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  return null
}

/**
 * Build the OpenAI content envelope for one turn: a text part (when non-empty)
 * followed by one part per attachment in the modality's native spelling.
 */
function buildContentParts(text: string, attachments: Attachment[]): ContentPart[] {
  const parts: ContentPart[] = []
  if (text) parts.push({ type: 'text', text })
  for (const att of attachments) {
    if (att.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: att.dataUrl } })
    } else if (att.kind === 'video') {
      parts.push({ type: 'video_url', video_url: { url: att.dataUrl } })
    } else {
      // The audio envelope wants the base64 payload and a format, not a data
      // URL — split them back out of what FileReader produced.
      const match = /^data:audio\/([^;,]+)?;base64,(.*)$/s.exec(att.dataUrl)
      parts.push({
        type: 'input_audio',
        input_audio: match
          ? { data: match[2] ?? '', format: match[1] || 'wav' }
          : { data: att.dataUrl, format: 'wav' },
      })
    }
  }
  return parts
}

// Mirrors the id generator in lib/toast.ts: crypto.randomUUID where the
// context is secure (it is not on plain-HTTP LAN deployments), else a
// timestamp+random composite.
const newMessageId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // ── Error formatting (Fix 5) ──────────────────────────────────────────────
  const formatError = (status: number, body: ErrorBody): string => {
    const errType: string = body?.error?.type ?? ''
    const errMsg: string = body?.error?.message ?? `HTTP ${status}`
    if (status === 401 || errType === 'authentication_error')
      return `🔑 Invalid API key. Regenerate it in Settings.`
    if (status === 429 || errType === 'rate_limit_error')
      return `⏳ All models are rate-limited. Wait a moment and try again.`
    if (status === 400 || errType === 'invalid_request_error')
      return `⚠️ ${errMsg}`
    if (status >= 500)
      return `🔌 Upstream provider error — the model returned an error.`
    return `❌ ${errMsg}`
  }

  // ── Streaming send (Fixes 3, 4, 6) ────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim()
    const sending = attachments
    // An attachment-only turn is valid: a picture with no caption is a normal
    // thing to send to a multimodal model.
    if ((!text && sending.length === 0) || loading) return

    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: text,
      attachments: sending.length > 0 ? sending : undefined,
    }
    const assistantMsg: ChatMessage = { id: newMessageId(), role: 'assistant', content: '' }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setInput('')
    setAttachments([])
    setLoading(true)
    inputRef.current?.focus()

    const controller = new AbortController()
    abortRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), 120_000)

    let content = ''
    let routedPlatform = ''
    let routedModel = ''
    let fallbackCount = 0
    let latency = 0
    const start = Date.now()

    // Throttled UI flush — updates the streaming message at ~30fps
    let pending = false
    const flush = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        if (!mountedRef.current) return
        pending = false
        setMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              content,
              meta: {
                platform: routedPlatform || undefined,
                model: routedModel || undefined,
                latency: undefined, // shown only when complete
                fallbackAttempts: fallbackCount > 0 ? fallbackCount : undefined,
                streaming: true,
              },
            }
          }
          return copy
        })
      })
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: ChatRequestBody = {
        // Media turns use the array envelope; plain text stays a string so the
        // request shape is unchanged for the common case.
        messages: [...messages, userMsg].map(m => ({
          role: m.role,
          content: m.attachments?.length
            ? buildContentParts(m.content, m.attachments)
            : m.content,
        })),
        stream: true,
      }
      if (selectedModel !== 'auto') body.model = selectedModel

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      // Read routing info from response headers (Fix 4)
      const routedVia = res.headers.get('X-Routed-Via')
      if (routedVia) {
        const slash = routedVia.indexOf('/')
        routedPlatform = slash === -1 ? routedVia : routedVia.slice(0, slash)
        routedModel = slash === -1 ? '' : routedVia.slice(slash + 1)
      }
      fallbackCount = parseInt(res.headers.get('X-Fallback-Attempts') ?? '0', 10)
      flush()

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        content = formatError(res.status, errBody)
        latency = Date.now() - start
        if (!mountedRef.current) {
          return
        }
        setMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              content,
              meta: {
                platform: routedPlatform || undefined,
                model: routedModel || undefined,
                latency,
                fallbackAttempts: fallbackCount > 0 ? fallbackCount : undefined,
              },
            }
          }
          return copy
        })
        return
      }

      // Stream the response (Fix 3)
      const reader = res.body?.getReader()
      if (!reader) {
        content = '❌ No response body — the server closed the connection.'
        latency = Date.now() - start
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)

          if (payload === '[DONE]') {
            reader.cancel()
            break
          }

          try {
            const chunk = JSON.parse(payload) as StreamChunk
            // In-band error frame (e.g. mid-stream provider error)
            if (chunk.error) {
              content += content ? '\n\n' : ''
              content += `⚠️ ${chunk.error.message ?? 'Stream error'}`
              reader.cancel()
              latency = Date.now() - start
              break
            }
            const delta = chunk.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              content += delta
              flush()
            }
          } catch {
            // ignore unparseable chunks
          }
        }
      }

      latency = Date.now() - start
    } catch (err: unknown) {
      latency = Date.now() - start
      const name = err instanceof Error ? err.name : ''
      const message = err instanceof Error ? err.message : String(err)
      if (name === 'AbortError') {
        if (!content) content = '(cancelled)'
      } else if (message === 'Failed to fetch') {
        content = '🔌 Connection failed — is the server running?'
      } else {
        content = `❌ ${message}`
      }
    } finally {
      clearTimeout(timeoutId)
      abortRef.current = null
      if (mountedRef.current) {
        setLoading(false)
        // Final update with complete metadata
        setMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.role === 'assistant') {
            copy[copy.length - 1] = {
              ...last,
              content: content || '(empty response)',
              meta: {
                platform: routedPlatform || undefined,
                model: routedModel || undefined,
                latency: latency > 0 ? latency : undefined,
                fallbackAttempts: fallbackCount > 0 ? fallbackCount : undefined,
              },
            }
          }
          return copy
        })
        setTimeout(() => inputRef.current?.focus(), 0)
      }
    }
  }, [input, loading, messages, keyData, selectedModel, attachments])

  const handleCancel = () => {
    abortRef.current?.abort()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (loading) return
      handleSend()
    }
  }

  const handleClear = () => {
    setMessages([])
    inputRef.current?.focus()
  }

  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : availableModels.find(m => `${m.platform}/${m.modelId}` === selectedModel)?.displayName ?? selectedModel

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Playground"
        description="Send a chat completion through the router and see which provider serves it."
        actions={
          <>
            <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (fallback chain)</SelectItem>
                {availableModels.map(m => (
                  <SelectItem key={m.modelDbId} value={`${m.platform}/${m.modelId}`}>
                    <span className="flex items-center gap-2">
                      <span>{m.displayName}</span>
                      <span className="text-xs text-muted-foreground">{m.platform}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear}>
                Clear
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 flex flex-col rounded-3xl border bg-card overflow-hidden min-h-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="space-y-2 max-w-sm">
                <p className="text-base font-medium">Send a message to get started.</p>
                <p className="text-sm text-muted-foreground">
                  Using <span className="text-foreground">{activeModelLabel}</span>. Switch models in the selector above.
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <span>
                        <Markdown>{msg.content}</Markdown>
                        {msg.meta?.streaming && (
                          <span className="inline-block w-1.5 h-4 bg-foreground/60 ml-0.5 align-text-bottom animate-pulse rounded-sm" />
                        )}
                      </span>
                    ) : (
                      <div className="space-y-2">
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {msg.attachments.map((att, i) => (
                              att.kind === 'image' ? (
                                <img
                                  key={`${msg.id}-att-${i}`}
                                  src={att.dataUrl}
                                  alt={att.name}
                                  className="max-h-40 rounded-lg border object-contain"
                                />
                              ) : (
                                <span
                                  key={`${msg.id}-att-${i}`}
                                  className="rounded-lg border border-primary-foreground/30 px-2 py-1 text-[11px]"
                                >
                                  {att.kind}: {att.name}
                                </span>
                              )
                            ))}
                          </div>
                        )}
                        {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
                      </div>
                    )}
                    {msg.meta && !msg.meta.streaming && (
                      <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                        {msg.meta.platform && <span>{msg.meta.platform}</span>}
                        {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                        {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                        {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                          <span>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-2xl px-4 py-3">
                    <div className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="border-t bg-background/50 p-3">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <span
                  key={`${att.name}-${i}`}
                  className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-2 py-1 text-xs"
                >
                  {att.kind === 'image' ? (
                    <img src={att.dataUrl} alt={att.name} className="size-6 rounded object-cover" />
                  ) : (
                    <span className="font-mono uppercase text-[10px] text-muted-foreground">{att.kind}</span>
                  )}
                  <span className="max-w-[10rem] truncate">{att.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${att.name}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,audio/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = '' // allow re-picking the same file
                for (const file of files) {
                  const kind = attachmentKind(file)
                  if (!kind) {
                    addToast({ kind: 'warning', title: 'Unsupported file', description: `${file.name}: only image, audio and video files are supported` })
                    continue
                  }
                  if (file.size > MAX_ATTACHMENT_BYTES) {
                    addToast({ kind: 'warning', title: 'File too large', description: `${file.name} exceeds the 15 MB attachment limit` })
                    continue
                  }
                  const reader = new FileReader()
                  reader.onload = () => {
                    const dataUrl = String(reader.result ?? '')
                    if (dataUrl) setAttachments(prev => [...prev, { kind, dataUrl, name: file.name }])
                  }
                  reader.onerror = () => addToast({ kind: 'warning', title: 'Read failed', description: `could not read ${file.name}` })
                  reader.readAsDataURL(file)
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message… (⏎ to send, ⇧⏎ for newline)"
              rows={1}
              className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
              style={{ height: 'auto', overflow: 'hidden' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 160) + 'px'
              }}
            />
            {loading ? (
              <Button onClick={handleCancel} variant="outline" size="default">
                Cancel
              </Button>
            ) : (
              <Button onClick={handleSend} disabled={(!input.trim() && attachments.length === 0)} size="default">
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
