import { useEffect, useRef } from 'react'
import { BASE } from '@/lib/api'

interface StreamEvent { type: string; [key: string]: unknown }

/**
 * Subscribe to /api/events SSE stream. The HttpOnly session cookie
 * authenticates automatically (EventSource sends same-origin cookies).
 * Calls onEvent for each parsed JSON message. Cleans up on unmount
 * or when `enabled` becomes false.
 */
export function useEventStream(onEvent: (event: StreamEvent) => void, enabled = true): void {
  const cbRef = useRef(onEvent)
  useEffect(() => {
    cbRef.current = onEvent
  })
  useEffect(() => {
    if (!enabled) return
    const onMessage = (msg: MessageEvent) => {
      try {
        const parsed = JSON.parse(msg.data)
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return
        cbRef.current(parsed as StreamEvent)
      } catch { /* ignore malformed */ }
    }
    // Same BASE as apiFetch — a sub-path deploy (VITE_BASE) must not lose
    // its event stream to a hardcoded root-relative URL.
    const es = new EventSource(`${BASE}/api/events`)
    es.onmessage = onMessage
    es.onerror = () => { /* EventSource auto-reconnects */ }
    return () => { es.close() }
  }, [enabled])
}
