import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEventStream } from '@/lib/use-event-stream';

// Mirrors server/src/services/events.ts LiveEvent union. Both ends drift
// occasionally (the proxy added `request.aborted` for client-disconnect
// tracking, and `stream.chunk` is reserved for live stream deltas); keep
// these lists in lockstep so the `formatEvent` switch stays exhaustive —
// otherwise an unhandled type reaches `addLine(undefined)` and the renderer
// throws on `l.ts`/`l.text`, tripping the ErrorBoundary. (#fix:see-changelog)
interface LiveEventBase {
  id: string;
  at: number;
}

interface RequestStartEvent extends LiveEventBase { type: 'request.start'; model?: string; stream: boolean; }
interface RequestDoneEvent extends LiveEventBase { type: 'request.done'; model: string; provider: string; keyId: number; latencyMs: number; tokens?: { in: number; out: number }; }
interface RequestErrorEvent extends LiveEventBase { type: 'request.error'; error: string; }
// Client-disconnect signal (Stop button, socket close, session reset).
// Emitted in three places in proxy.ts plus three in responses.ts — every
// retry/recovery path triggers it on a graceful cancellation.
interface RequestAbortedEvent extends LiveEventBase { type: 'request.aborted'; }
// Reserved for future per-token live stream delta display. Not published
// today; declared so adding a producer doesn't silently unbalance the
// client union again.
interface StreamChunkEvent extends LiveEventBase { type: 'stream.chunk'; text: string; }
interface KeyExhaustedEvent extends LiveEventBase { type: 'routing.key_exhausted'; provider: string; keyId: number; model: string; reason: string; }
interface KeyRetryEvent extends LiveEventBase { type: 'routing.key_retry'; provider: string; keyId: number; model: string; attempt: number; max: number; }
// Key rotated to a sibling key for the same model after the previous one
// exhausted. Distinct from `routing.model_switch` (which fires when the model
// itself changes) so the live terminal can show the user that the proxy is
// retrying on a different KEY, not a different MODEL. (#256)
interface KeySwitchEvent extends LiveEventBase { type: 'routing.key_switch'; provider: string; model: string; fromKeyId: number; toKeyId: number; }
interface ModelSwitchEvent extends LiveEventBase { type: 'routing.model_switch'; from: string; to: string; reason: string; }
interface RecoveryEvent extends LiveEventBase { type: 'routing.recovery'; cycle: number; max: number | null; reason: string; }
// Health-check progress. Mirrors server/src/services/events.ts — the
// KeysPage subscribes to these for live "Check all" feedback so the
// operator sees a progress bar update as each key resolves, instead of
// a frozen spinner that gave zero feedback for 15+ minutes on a 89-key
// fleet. The id/at fields come from LiveEventBase so the events flow
// through the same SSE pipeline; the live-terminal formatter suppresses
// them (they're owned by the KeysPage progress bar). (#256)
interface HealthCheckStartEvent extends LiveEventBase { type: 'health.check.start'; total: number; concurrency: number; }
interface HealthCheckProgressEvent extends LiveEventBase { type: 'health.check.progress'; keyId: number; platform: string; status: string; completed: number; total: number; }
interface HealthCheckDoneEvent extends LiveEventBase { type: 'health.check.done'; total: number; }

// Middle-layer interceptor events. The interceptor makes its own AI call to
// scan messages for new secrets — these events make that call visible in the
// live feed so the operator can see when the interceptor fires and whether it
// succeeded or timed out. (#B2-4)
interface InterceptorStartEvent extends LiveEventBase { type: 'interceptor.start'; model: string; provider: string; }
interface InterceptorDoneEvent extends LiveEventBase { type: 'interceptor.done'; model: string; provider: string; keyId: number; latencyMs: number; secretsFound: number; }
interface InterceptorErrorEvent extends LiveEventBase { type: 'interceptor.error'; model: string; provider: string; error: string; }

type LiveEvent =
  | RequestStartEvent | RequestDoneEvent | RequestErrorEvent | RequestAbortedEvent
  | StreamChunkEvent
  | KeyExhaustedEvent | KeyRetryEvent | KeySwitchEvent | ModelSwitchEvent | RecoveryEvent
  | HealthCheckStartEvent | HealthCheckProgressEvent | HealthCheckDoneEvent
  | InterceptorStartEvent | InterceptorDoneEvent | InterceptorErrorEvent;

interface LogEntry {
  id: string;
  text: string;
  ts: number;
  kind: 'start' | 'done' | 'error' | 'info';
}

const MAX_LOG_LINES = 10000;
const RENDER_SLICE = 100;

function formatEvent(evt: LiveEvent): LogEntry | undefined {
  // Defensive: a malformed or under-specified event (missing id/at fields
  // from a future server-side addition that drifts from the union) must
  // never reach `addLine` — `lines.map(...)` downstream reads `l.ts` and
  // `l.text`, so a partial entry would throw and trip the ErrorBoundary.
  // Id-safe slicing: some future event source might omit `id`; in that case
  // fall back to the type-driven prefix so the line is still readable.
  if (typeof evt?.id !== 'string' || typeof evt?.at !== 'number') return undefined;
  const ts = evt.at;
  const rId = evt.id.slice(0, 8);
  const e = evt; // narrowed alias used below; safe to read any LiveEvent field.
  switch (e.type) {
    case 'request.start':
      return { id: e.id, ts, kind: 'start', text: `▶ [${rId}] Request started${e.model ? ` (pinned: ${e.model})` : ' (auto)'} — ${e.stream ? 'streaming' : 'non-stream'}` };
    case 'request.done':
      return { id: e.id, ts, kind: 'done', text: `✓ [${rId}] ${e.provider}/${e.model} key#${e.keyId} — ${e.latencyMs}ms${e.tokens ? `, ${e.tokens.in}↓/${e.tokens.out}↑ tokens` : ''}` };
    case 'request.error':
      return { id: e.id, ts, kind: 'error', text: `✗ [${rId}] ${e.error}` };
    case 'interceptor.start':
      return { id: e.id, ts, kind: 'info', text: `🛡 [${rId}] Interceptor scanning via ${e.provider}/${e.model}` };
    case 'interceptor.done':
      return { id: e.id, ts, kind: 'info', text: `🛡 [${rId}] Interceptor done: ${e.provider}/${e.model} key#${e.keyId} — ${e.latencyMs}ms, ${e.secretsFound} secret(s) found` };
    case 'interceptor.error':
      return { id: e.id, ts, kind: 'error', text: `🛡 [${rId}] Interceptor error on ${e.provider}/${e.model}: ${e.error}` };
    case 'request.aborted':
      // Client disconnection (Stop button, socket close, session reset).
      // Before this case landed, an aborted-then-completed switch would
      // fall through and `addLine(undefined)` would push undefined into
      // `lines`, which then crashed the renderer.
      return { id: e.id, ts, kind: 'info', text: `⏹ [${rId}] Request aborted (client disconnected)` };
    case 'stream.chunk':
      // Reserved for future per-token live delta; render as info so a
      // producer can be enabled without further client changes.
      return { id: e.id, ts, kind: 'info', text: e.text };
    case 'health.check.start':
    case 'health.check.progress':
    case 'health.check.done':
      // Health-check progress events are owned by the KeysPage progress
      // bar (client/src/pages/KeysPage.tsx). The live terminal is a
      // request/error log; routing health-check traffic through it would
      // spam the operator with no useful information. Drop them here. (#256)
      return undefined;
    case 'routing.key_exhausted':
      return { id: e.id, ts, kind: 'info', text: `⚠ [${rId}] Key #${e.keyId} exhausted on ${e.provider}/${e.model}: ${e.reason}` };
    case 'routing.key_retry':
      return { id: e.id, ts, kind: 'info', text: `↻ [${rId}] Retrying ${e.provider}/${e.model} key#${e.keyId} (${e.attempt}/${e.max})` };
    case 'routing.key_switch':
      // Same model, different key — the proxy rotated to a sibling key
      // because the previous one exhausted. Distinct from
      // routing.model_switch so the operator can see "this key was swapped
      // out" vs "we fell through to a different model entirely". (#256)
      return { id: e.id, ts, kind: 'info', text: `⇄ [${rId}] ${e.provider}/${e.model}: rotating key #${e.fromKeyId} → #${e.toKeyId}` };
    case 'routing.model_switch':
      return { id: e.id, ts, kind: 'info', text: `→ [${rId}] Switching model: ${e.from} → ${e.to}` };
    case 'routing.recovery':
      return { id: e.id, ts, kind: 'info', text: `⏳ [${rId}] Recovery cycle ${e.cycle}${e.max ? `/${e.max}` : '/\u221E'}: ${e.reason}` };
    default: {
      // Forward-compatibility net: a future server-side event type that the
      // client switch above hasn't learned about yet MUST render as a
      // generic info line rather than fall through to `undefined`. This is
      // the single load-bearing line in the file — if it ever stops being
      // the catch-all, we get the "Reload button on the dashboard" bug
      // back. Co-located with the switch keeps the invariant local.
      // Runtime `type` is the discriminator we just enumerated.
      // `e` is `never` with a statically exhaustive switch; cast to the
      // base interface so we can still read `id`/`type` for the fallback.
      const anyEvent = e as { id?: unknown; type?: unknown };
      const fallbackId = typeof anyEvent.id === 'string' ? anyEvent.id.slice(0, 8) : 'unknown';
      return {
        id: typeof anyEvent.id === 'string' ? anyEvent.id : `unknown-${ts}`,
        ts,
        kind: 'info',
        text: `· [${fallbackId}] (unrecognised event: ${String(anyEvent.type ?? 'unknown')})`,
      };
    }
  }
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LiveEvents() {
  const [expanded, setExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(new Set<string>());
  const autoScrollRef = useRef(true);

  // Keep the ref in sync with state so the onScroll handler (which is not
  // a React effect and doesn't get fresh state) always reads the current value.
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

  const scrollToBottom = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // `addLine` accepts undefined and drops it; the render loop reads `l.ts`/
  // `l.text` on every entry, so any nullish line is a renderer-crash hazard.
  // `formatEvent` already filters unknown/malformed events by returning
  // undefined; this is the second line of defence so the event handler below
  // can stay terse.
  const addLine = useCallback((entry: LogEntry | undefined) => {
    if (!entry) return;
    setLines(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  useEventStream((parsed) => {
    const entry = formatEvent(parsed as unknown as LiveEvent);

    if (parsed.type === 'request.start') {
      activeRef.current.add(parsed.id as string);
      setActiveCount(activeRef.current.size);
    } else if (parsed.type === 'request.done' || parsed.type === 'request.error' || parsed.type === 'request.aborted') {
      // request.aborted also clears the in-flight counter — a request
      // that completes via abort has no separate 'done' frame and would
      // otherwise leak its 'start' id forever, leaving the pulsing dot
      // stuck on screen.
      activeRef.current.delete(parsed.id as string);
      setActiveCount(activeRef.current.size);
    }

    addLine(entry);
  });

  // Scroll to bottom on new lines when autoScroll is on.
  // useLayoutEffect fires synchronously after DOM mutation, before paint —
  // eliminates the race where the browser paints stale scroll position.
  // All scroll operations target only the log container, never the page.
  useLayoutEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [lines.length, autoScroll, scrollToBottom, expanded]);

  // Detect manual scroll-up and auto-pause auto-scroll.
  // When the user scrolls away from the bottom, turn off auto-scroll so
  // new events don't yank the view back down.
  const onScroll = useCallback(() => {
    if (!autoScrollRef.current) return;
    const el = logContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 30) {
      setAutoScroll(false);
    }
  }, []);

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll(prev => {
      const next = !prev;
      if (next) {
        // Re-enabling: immediately scroll to bottom so the user sees the latest
        requestAnimationFrame(() => scrollToBottom());
      }
      return next;
    });
  }, [scrollToBottom]);

  const clearLogs = () => setLines([]);

  return (
    <div className="rounded-3xl border bg-card mb-6">
      {/* Header bar — always visible */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium">Live Feed</h3>
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              {activeCount} active
            </span>
          )}
          {lines.length > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {lines.length} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={autoScroll ? 'secondary' : 'ghost'}
            size="xs"
            onClick={toggleAutoScroll}
            title={autoScroll ? 'Auto-scroll ON — click to pause' : 'Auto-scroll OFF — click to resume'}
            className="gap-1.5"
          >
            <span className={`relative flex size-2 ${autoScroll ? '' : 'opacity-40'}`}>
              <span className={`absolute inline-flex h-full w-full rounded-full ${autoScroll ? 'animate-ping bg-emerald-400 opacity-75' : 'bg-muted-foreground'}`} />
              <span className={`relative inline-flex size-2 rounded-full ${autoScroll ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
            </span>
            Live
          </Button>
          <Button variant="ghost" size="xs" onClick={clearLogs} title="Clear log">
            Clear
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => setExpanded(v => !v)} title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </div>
      </div>
      {/* Log area */}
      <div
        ref={logContainerRef}
        onScroll={onScroll}
        className={`overflow-y-auto font-mono text-[11px] leading-relaxed bg-muted text-muted-foreground rounded-b-3xl transition-all duration-200 ${
          expanded ? 'max-h-[480px]' : 'max-h-[144px]'
        }`}
      >
        {lines.length === 0 ? (
          <div className="px-4 py-6 text-center text-muted-foreground/50 text-xs">
            Waiting for requests… Open a new terminal and send a request to see live routing activity.
          </div>
        ) : (
          <div className="py-1.5">
            {lines.slice(-RENDER_SLICE).map((l, i) => (
              <div
                key={`${l.id}-${i}`}
                className={`px-4 py-0.5 whitespace-pre-wrap break-all ${
                  l.kind === 'error' ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10'
                  : l.kind === 'done' ? 'text-emerald-600 dark:text-emerald-400'
                  : l.kind === 'start' ? 'text-sky-600 dark:text-sky-400'
                  : 'text-muted-foreground'
                }`}
              >
                <span className="text-muted-foreground/50 mr-2 select-none tabular-nums">{timeLabel(l.ts)}</span>
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
