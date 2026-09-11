import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolDefinition,
} from '@api-gateway/shared/types.js';
import { BaseProvider, providerHttpError, RequestAbortError, type CompletionOptions, type DiscoveredModel } from './base.js';
import { fetchCommandCodeCatalog } from './commandcode-models.js';
import { createAbortRace } from '../lib/abort.js';
import { createHash, randomBytes } from 'node:crypto';

const NPM_VERSION_URL = 'https://registry.npmjs.org/command-code/latest';
const API_BASE = 'https://api.commandcode.ai';
/** Fallback max_tokens when neither the caller nor the catalog specifies one.
 *  Matches the Go reference proxy (proxy.go:92). */
const FALLBACK_MAX_TOKENS = 64000;
/** Default temperature. The Go reference proxy defaults to 0.3, but
 *  the CommandCode API is tuned for 0.7 (matching the Livebench/default
 *  consensus observed across providers). */
const DEFAULT_TEMPERATURE = 0.7;
const STREAM_TIMEOUT_MS = 300000; // 5 min — same as BaseProvider.readSseStream
const VERSION_FALLBACK = '0.18.10'; // upstream's minVersion — safe floor if npm is unreachable
const MIN_SUPPORTED_VERSION = '0.18.10';
/** Hard upper bound the CommandCode /alpha/generate API enforces on
 *  params.max_tokens. Verified live 2026-06-19: values above 200_000 return
 *  400 BAD_REQUEST ("Too big: expected number to be <=200000 at
 *  \"params.max_tokens\""). The catalog's max_output_tokens can be higher
 *  (e.g. 262144 for deepseek-v4-pro, MiniMax-M3) — we clamp to this ceiling
 *  so those models don't permanently 400. This is the maximum possible
 *  output length the upstream allows, not an arbitrary default. */
const API_MAX_TOKENS = 200000;

let cachedVersion: string | undefined;
let versionPromise: Promise<string> | undefined;

/** Fetch the latest command-code npm version, cached for the process lifetime.
 * Mirrors the Go proxy's behavior of sending an up-to-date x-command-code-version. */
async function getCommandCodeVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  if (versionPromise) return versionPromise;

  versionPromise = (async () => {
    try {
      const res = await fetch(NPM_VERSION_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return VERSION_FALLBACK;
      const pkg = (await res.json()) as { version?: string };
      const v = typeof pkg.version === 'string' ? pkg.version : VERSION_FALLBACK;
      // Always send at least the known-minimum so the upstream doesn't 426 us
      cachedVersion = compareVersions(v, MIN_SUPPORTED_VERSION) < 0 ? MIN_SUPPORTED_VERSION : v;
      return cachedVersion;
    } catch {
      cachedVersion = VERSION_FALLBACK;
      return cachedVersion;
    } finally {
      versionPromise = undefined;
    }
  })();
  return versionPromise;
}

/** Loose semver-ish compare: returns <0 if a<b, 0 if equal, >0 if a>b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(p => parseInt(p, 10) || 0);
  const pb = b.split('.').map(p => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// ── Per-key session + device fingerprint (anti-detection lifecycle) ──────
// Ported from the reference proxy (commandcode-proxy/proxy.mjs): upstream
// scores requests by CLI-session realism. Each API key gets its own stable
// session UUID (12h + 1h jitter) and device fingerprint; fingerprint-record
// and lifecycle pre-requests fire on first use and then every 8h ± 2h.

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12h
const SESSION_JITTER_MS = 60 * 60 * 1000;        // ±1h

const sessionStore = new Map<string, { sessionId: string; expiresAt: number }>();

function ensureSession(apiKey: string): string {
  const now = Date.now();
  const entry = sessionStore.get(apiKey);
  if (entry && now < entry.expiresAt) return entry.sessionId;
  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS);
  const sessionId = crypto.randomUUID();
  sessionStore.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter });
  return sessionId;
}

const FINGERPRINT_CPUS: Array<{ model: string; cores: number }> = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
];
const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64];
const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5];

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function randHex(n: number): string {
  return randomBytes(n).toString('hex');
}

interface FingerprintComponents {
  machineIdHash: string;
  macHashes: string[];
  osUserHash: string;
  hostnameHash: string;
  gitEmailHash: string;
  platform: string;
  arch: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  memGiB: number;
  isContainer: boolean;
  timezone: string;
  runtime: string;
  collectorVersion: number;
}

interface DeviceFingerprint {
  thumbmark: string;
  components: FingerprintComponents;
}

/** Generate a randomized Windows-CLI device fingerprint (verbatim port of the
 *  reference proxy's generateFingerprint — the pools and hash composition are
 *  what the upstream scores, so they must not be "improved"). */
function generateFingerprint(): DeviceFingerprint {
  const cpuEntry = FINGERPRINT_CPUS[Math.floor(Math.random() * FINGERPRINT_CPUS.length)];
  const memGiB = FINGERPRINT_MEMS[Math.floor(Math.random() * FINGERPRINT_MEMS.length)];
  const tz = FINGERPRINT_TZS[Math.floor(Math.random() * FINGERPRINT_TZS.length)];
  const macCount = FINGERPRINT_MAC_COUNT_RANGE[Math.floor(Math.random() * FINGERPRINT_MAC_COUNT_RANGE.length)];

  const macHashes: string[] = [];
  for (let i = 0; i < macCount; i++) macHashes.push(sha256(randHex(32)));

  const machineIdHash = sha256(randHex(32));
  const osUserHash = sha256(randHex(16));
  const hostnameHash = sha256(randHex(16));
  const gitEmailHash = sha256(randHex(16));

  const thumbData = [machineIdHash, ...macHashes, osUserHash, hostnameHash, gitEmailHash, 'win32', '10.0.22631', cpuEntry.model, String(cpuEntry.cores), String(memGiB)].join('|');
  const thumbmark = sha256(thumbData);

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: false,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

interface CommandCodeKeyState {
  fingerprint: DeviceFingerprint;
  nextInitAt: number;
}

const keyStateStore = new Map<string, CommandCodeKeyState>();

function getOrCreateKeyState(apiKey: string): CommandCodeKeyState {
  let state = keyStateStore.get(apiKey);
  if (!state) {
    state = { fingerprint: generateFingerprint(), nextInitAt: 0 };
    keyStateStore.set(apiKey, state);
  }
  return state;
}

const INIT_REFRESH_MS = 8 * 60 * 60 * 1000; // 8h
const INIT_JITTER_MS = 2 * 60 * 60 * 1000;  // ±2h

/** Fire the fingerprint-record + lifecycle pre-requests for a key on first use
 *  and every 8h ± 2h after. Never throws and never blocks longer than the
 *  per-request timeouts — a failed pre-request must not fail the chat call. */
async function ensureInitialized(apiKey: string): Promise<void> {
  const state = getOrCreateKeyState(apiKey);
  if (Date.now() < state.nextInitAt) return;
  const version = await getCommandCodeVersion();
  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${apiKey}`,
      'x-command-code-version': version,
    };
    const fingerprint = state.fingerprint;

    const results = await Promise.allSettled([
      fetch(`${API_BASE}/alpha/fingerprint/record`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify(fingerprint),
      }),
      fetch(`${API_BASE}/alpha/lifecycle-events`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${randomBytes(8).toString('hex')}`,
            cliVersion: version,
            mode: 'interactive',
            os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
          },
        }),
      }),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`[commandcode] init pre-request failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      } else if (!r.value.ok) {
        console.warn(`[commandcode] init pre-request got HTTP ${r.value.status}`);
        try { await r.value.body?.cancel(); } catch { /* already closed */ }
      }
    }
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + Math.floor(Math.random() * INIT_JITTER_MS);
  } catch (err) {
    console.warn(`[commandcode] fingerprint/lifecycle refresh error, will retry next request: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Hourly sweep so the per-key maps don't grow unbounded. unref'd: it must not
// keep the event loop (or a vitest worker) alive on its own.
const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      keyStateStore.delete(key);
    }
  }
}, 60 * 60 * 1000);
if (typeof sessionCleanupTimer.unref === 'function') sessionCleanupTimer.unref();

/** Build a plausible Windows project slug from a session id (reference proxy
 *  fakeProjectSlug — deterministic per session, shaped like the real CLI's). */
function fakeProjectSlug(sessionId: string): string {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker'];
  const id = String(sessionId || '');
  const head = id.slice(0, 4);
  let idx = parseInt(head, 16);
  if (!Number.isFinite(idx)) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    idx = h;
  }
  const name = names[idx % names.length];
  const suffix = head || '0000';
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`;
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateTraceparent(): string {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

/** Test hook: clear per-key session/fingerprint/init state. */
export function resetCommandCodeSessionState(): void {
  sessionStore.clear();
  keyStateStore.clear();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Option mapping helpers ───────────────────────────────────────────────

/** Resolve the reasoning-effort level CommandCode understands. Upstream
 *  validates params.reasoning_effort against low|medium|high|xhigh|max
 *  (live-verified 2026-09-11); 'minimal' is a gateway-only level and maps to
 *  'low'. The rich `thinking` object is NOT forwarded — upstream has no such
 *  param — and `thinking.type === 'disabled'` omits the field entirely
 *  (upstream always thinks; there is no disable path). */
function resolveReasoningEffort(options?: CompletionOptions): string | undefined {
  if (options?.thinking?.type === 'disabled') return undefined;
  const effort = options?.thinking?.effort ?? options?.reasoning_effort;
  if (!effort) return undefined;
  return effort === 'minimal' ? 'low' : effort;
}

/** Map the OpenAI tool_choice shape to CommandCode's Anthropic-style shape
 *  (reference proxy: strings auto/none → same, required → 'any'; function
 *  object → {type:'tool', name}). */
function mapToolChoice(toolChoice: NonNullable<CompletionOptions['tool_choice']>): Record<string, unknown> {
  if (typeof toolChoice === 'string') {
    const map: Record<string, string> = { auto: 'auto', none: 'none', required: 'any' };
    return { type: map[toolChoice] ?? 'auto' };
  }
  return { type: 'tool', name: toolChoice.function.name };
}

/** Pull the URL/data-URI out of any image-shaped content part. Accepts the
 *  OpenAI object form ({image_url:{url}}), the shorthand string form
 *  ({image_url:'…'}), google-style ({type:'image', image:'…'}), and
 *  Responses-style ({type:'input_image', image_url:'…'}). */
function extractImageUrl(b: Record<string, unknown>): string | null {
  const iu = b['image_url'];
  if (typeof iu === 'string' && iu.length > 0) return iu;
  if (iu && typeof iu === 'object' && typeof (iu as Record<string, unknown>)['url'] === 'string') {
    return (iu as Record<string, unknown>)['url'] as string;
  }
  if (typeof b['image'] === 'string' && b['image'].length > 0) return b['image'];
  if (typeof b['url'] === 'string' && b['url'].length > 0) return b['url'];
  return null;
}

/** Anti false-billing (reference proxy normalizeUsage): a finish event with
 *  no output tokens is a glitched response — zero the input tokens too so
 *  spend accounting never charges a prompt for a response that produced
 *  nothing. */
function normalizeUsage(u: { inputTokens?: number; outputTokens?: number } | undefined): void {
  if (!u) return;
  if (!Number(u.outputTokens)) u.inputTokens = 0;
}

// ── CommandCode wire types ───────────────────────────────────────────────

interface CCContentBlock {
  type: string;
  text?: string;
  image?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolCallId?: string;
  toolName?: string;
  tool_use_id?: string;
  content?: unknown;
  output?: { type: string; value: string };
}

interface CCStreamEvent {
  type: string;
  text?: string;
  id?: string;
  delta?: string;
  input?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  finishReason?: string;
  totalUsage?: { inputTokens: number; outputTokens: number };
  // Optional reasoning fields. CommandCode's wrapper surfaces model-side
  // reasoning traces under varying keys depending on the underlying model;
  // we capture any of these so OpenAI-format clients can preserve the trace
  // for multi-turn replay. (#290)
  reasoning?: string;
  reasoningContent?: string;
  reasoning_content?: string;
  thinking?: string | { text?: string; thinking?: string };
  redacted_thinking?: string;
  error?: { message: string; statusCode?: number };
}

/** Normalize the variable-shape reasoning field on CCStreamEvent to a string.
 * CommandCode's wrapper surfaces reasoning traces under varying keys
 * depending on the underlying model (`reasoning`, `text`, `thinking`
 * as object/string, …). This helper flattens any of them. (#290) */
function extractReasoningFromEvent(event: CCStreamEvent): string {
  if (typeof event.reasoning_content === 'string') return event.reasoning_content;
  if (typeof event.reasoningContent === 'string') return event.reasoningContent;
  if (typeof event.reasoning === 'string') return event.reasoning;
  if (typeof event.redacted_thinking === 'string') return event.redacted_thinking;
  if (typeof event.thinking === 'string') return event.thinking;
  if (event.thinking && typeof event.thinking === 'object') {
    const inner = event.thinking.text ?? event.thinking.thinking;
    if (typeof inner === 'string') return inner;
  }
  if (typeof event.text === 'string' && event.type?.toLowerCase().includes('reason')) {
    return event.text;
  }
  return '';
}

interface StreamingToolDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface StreamingDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: StreamingToolDelta[];
  reasoning_content?: string;
}

// ── Param-retraction contingency ─────────────────────────────────────────
// A 400 whose body names `params.<field>` means this upstream build rejects
// the field. Retry once without it and never send it again for the process
// lifetime (one upstream API — a field rejected for one model is rejected
// for all).

const RETRACTABLE_PARAMS = ['tool_choice', 'parallel_tool_calls', 'reasoning_effort'] as const;
const retractedParams = new Set<string>();

// ── Provider ─────────────────────────────────────────────────────────────

export class CommandCodeProvider extends BaseProvider {
  readonly platform = 'commandcode' as const;
  readonly name = 'CommandCode';
  // baseUrl left undefined — CommandCode has no OpenAI /models endpoint, so
  // the baseUrl-based discovery path skips this provider. Model discovery is
  // provided by the website-scraping hook instead (see commandcode-models.ts).

  /** Website-catalog discovery: the CommandCode API has no /models endpoint,
   *  so the catalog comes from the two public docs/marketing pages instead
   *  (see commandcode-models.ts). Reasoning-glyph models get the upstream's
   *  live-verified thinking-effort enum; non-reasoning models get ['off']. */
  async discoverModels(): Promise<DiscoveredModel[]> {
    const rows = await fetchCommandCodeCatalog();
    return rows.map(r => ({
      modelId: r.modelId,
      displayName: r.displayName,
      contextWindow: r.contextWindow,
      supportsVision: r.supportsVision,
      reasoning: r.reasoning,
      intelligenceScore: r.intelligenceScore,
      tokensPerSecond: r.tokensPerSecond,
      inputPerM: r.inputPerM,
      outputPerM: r.outputPerM,
      cacheReadPerM: r.cacheReadPerM,
      cacheWritePerM: r.cacheWritePerM,
      thinkingLevels: r.reasoning ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['off'],
    }));
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.postGenerate(apiKey, messages, modelId, options);
    return this.collectNonStreamResponse(res, modelId);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.postGenerate(apiKey, messages, modelId, options);
    yield* this.streamNdjsonResponse(res, modelId, options?.abortSignal);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const headers = await this.requestHeaders(apiKey);
      const res = await this.fetchWithTimeout(`${API_BASE}/alpha/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          config: this.defaultConfig(),
          memory: '',
          taste: '',
          skills: '',
          params: { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], system: '', max_tokens: 1, temperature: 0.7, stream: true, tools: [] },
          threadId: crypto.randomUUID(),
        }),
      }, 15000);
      // A 2xx, or any 5xx (upstream fault, not a key problem) → key is valid.
      if (res.ok || res.status >= 500) return true;
      // CommandCode surfaces "key is authentic but can't serve right now" as:
      //   - 429  code:"RATE_LIMITED"   → weekly plan usage limit hit (resets later)
      //   - 400  code:"BAD_REQUEST"     → "You have insufficient credits to make this
      //                                   request." (balance exhausted; works after a top-up)
      // Both mean the key passed auth — marking it permanently `invalid` (the prior
      // behavior) excludes it from routing forever and, after 3 sweeps, auto-disables
      // it (`enabled=0`) so the health checker never re-validates it. Treat them as
      // valid: the key stays routable and self-heals when the quota resets; the chat
      // path's retry/cooldown already benches it transiently when an actual call 429s.
      // A genuine 401/403 (bad/expired token) still falls through to `false`.
      if (res.status === 429 || res.status === 402) return true;
      if (res.status === 400) {
        const err = await res.text().catch(() => '');
        // Match the exact exhausted-credits phrasing from the live upstream, not bare
        // 400, so a real bad-request (e.g. a body the API rejects on shape) is NOT
        // misclassified as a valid key.
        if (/insufficient credits|insufficient\s+balance|weekly usage limit|rate[-_ ]?limited|quota|out of credit/i.test(err)) return true;
      }
      // M23: consume/cancel the response body BEFORE returning — the probe
      // fires with stream:true and previously left the upstream socket
      // hanging, leaking a connection per health-check sweep.
      try { await res.body?.cancel(); } catch { /* already closed */ }
      return false;
    } catch (err) {
      // M23: transport failures (DNS, timeout, TLS) previously returned `true`
      // — a VALID verdict for a key that may well be bad. Let them propagate:
      // the health checker already classifies a thrown transport error as a
      // transient 'error' rather than 'invalid', which is the honest answer.
      throw err;
    }
  }

  // ── Request dispatch ───────────────────────────────────────────────────

  /** POST /alpha/generate with the param-retraction contingency applied. */
  private async postGenerate(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const body = this.buildRequestBody(messages, modelId, options);
      const params = body['params'] as Record<string, unknown>;
      for (const field of retractedParams) delete params[field];
      const headers = await this.requestHeaders(apiKey);
      return this.fetchWithTimeout(`${API_BASE}/alpha/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, options?.timeoutMs ?? 120000, options?.abortSignal);
    };

    let res = await send();
    if (res.ok) return res;
    let err = await res.text().catch(() => '');
    if (res.status === 400) {
      const named = RETRACTABLE_PARAMS.find(f => !retractedParams.has(f) && err.includes(`params.${f}`));
      if (named) {
        retractedParams.add(named);
        try { await res.body?.cancel(); } catch { /* already closed */ }
        res = await send();
        if (res.ok) return res;
        err = await res.text().catch(() => '');
      }
    }
    throw providerHttpError(res, `CommandCode API error ${res.status}: ${err}`);
  }

  private async requestHeaders(apiKey: string): Promise<Record<string, string>> {
    // Session/fingerprint lifecycle: warn-and-continue by contract.
    await ensureInitialized(apiKey);
    const version = await getCommandCodeVersion();
    const sessionId = ensureSession(apiKey);
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-command-code-version': version,
      'x-cli-environment': 'production',
      // N18: the stream endpoint replies with newline-delimited JSON (see
      // readNdjsonEvents), not SSE — ask for the right media type.
      'Accept': 'application/x-ndjson',
      // Session realism headers (reference proxy forwardToCC).
      'x-session-id': sessionId,
      'x-co-flag': 'false',
      'x-taste-learning': 'false',
      'x-project-slug': fakeProjectSlug(sessionId),
      'traceparent': generateTraceparent(),
    };
  }

  // ── Request building ───────────────────────────────────────────────────

  private buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Record<string, unknown> {
    const system = this.buildSystemText(messages);
    const ccMessages = this.convertMessages(messages);
    const tools = this.convertTools(options?.tools);
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    // The CommandCode API rejects max_tokens > 200_000 with 400. The catalog
    // stores per-model max_output_tokens which can exceed this (e.g. 262144 for
    // deepseek-v4-pro), and callers may also ask for more than the upstream
    // accepts. Clamp to the API ceiling so no request trips the 400.
    const maxTokens = Math.min(options?.max_tokens ?? FALLBACK_MAX_TOKENS, API_MAX_TOKENS);
    const params: Record<string, unknown> = {
      model: modelId,
      messages: ccMessages,
      tools,
      // Upstream injects ~7.5K tokens of its own system prompt when
      // params.system is absent/empty (live-measured prompt_tokens 7653 → 85
      // with the single-space placeholder; reference proxy issue #17). The
      // placeholder suppresses the injection without changing semantics.
      system: system.length > 0 ? system : ' ',
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };
    const effort = resolveReasoningEffort(options);
    if (effort) params['reasoning_effort'] = effort;
    if (options?.tool_choice) params['tool_choice'] = mapToolChoice(options.tool_choice);
    if (options?.parallel_tool_calls !== undefined) params['parallel_tool_calls'] = options.parallel_tool_calls;
    return {
      config: this.defaultConfig(),
      memory: '',
      taste: '',
      skills: '',
      params,
      threadId: crypto.randomUUID(),
    };
  }

  private defaultConfig(): Record<string, unknown> {
    return {
      workingDir: '.',
      date: new Date().toISOString().slice(0, 10),
      environment: 'cli',
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: 'main',
      gitStatus: '',
      recentCommits: [],
    };
  }

  // ── Message translation ────────────────────────────────────────────────

  private buildSystemText(messages: ChatMessage[]): string {
    let system = '';
    for (const m of messages) {
      if (m.role === 'system') {
        if (system.length > 0) system += '\n';
        system += this.blockText(m.content);
      }
    }
    return system;
  }

  private convertMessages(messages: ChatMessage[]): Array<{ role: string; content: CCContentBlock[] }> {
    const toolNames = new Map<string, string>();
    for (const m of messages) {
      if (m.role === 'assistant' && 'tool_calls' in m) {
        const calls = (m as { tool_calls?: ChatToolCall[] }).tool_calls;
        if (calls) {
          for (const tc of calls) {
            if (tc.id && tc.function?.name) toolNames.set(tc.id, tc.function.name);
          }
        }
      }
    }

    const out: Array<{ role: string; content: CCContentBlock[] }> = [];
    for (const m of messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        const toolMsg = m as ChatMessage & { tool_call_id: string };
        const name = (m as { name?: string }).name || toolNames.get(toolMsg.tool_call_id) || 'unknown';
        const val = this.blockText(m.content);
        out.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: toolMsg.tool_call_id, toolName: name, output: { type: val.startsWith('Error:') ? 'error-text' : 'text', value: val } }],
        });
        continue;
      }

      if (m.role === 'assistant' && 'tool_calls' in m) {
        const a = m as ChatMessage & { tool_calls?: ChatToolCall[] };
        const blocks: CCContentBlock[] = this.contentToBlocks(m.content);
        const added = new Set(blocks.filter(b => b.type === 'tool-call' && b.toolCallId).map(b => b.toolCallId!));

        for (const tc of a.tool_calls ?? []) {
          if (added.has(tc.id)) continue;
          blocks.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function?.name, input: this.safeParseJson(tc.function?.arguments) });
          added.add(tc.id);
        }
        out.push({ role: 'assistant', content: blocks });
        continue;
      }

      out.push({ role: m.role, content: this.contentToBlocks(m.content) });
    }
    return out;
  }

  /** Extract the text value from an individual content block object, mirroring
   *  the Go proxy's `contentPartToString()` in convert.go. Key difference from
   *  lib/content.ts's `contentToString`: that function operates on a whole
   *  message (string | null | array), NOT on single block objects — a bare
   *  `{type:'text',text:'Hello'}` returns '' from it, silently dropping user
   *  content. This helper handles single blocks directly. */
  private blockText(block: unknown): string {
    if (block === null || block === undefined) return '';
    if (typeof block === 'string') return block;
    if (Array.isArray(block)) {
      return block.map(b => this.blockText(b)).join('');
    }
    if (typeof block === 'object') {
      const b = block as Record<string, unknown>;
      // Common text-carrying keys — same order as Go reference
      for (const key of ['text', 'content', 'output_text', 'input_text', 'refusal', 'thinking', 'redacted_thinking']) {
        if (typeof b[key] === 'string') return b[key] as string;
      }
      // Fallback: stringify the block
      try { return JSON.stringify(b); } catch { return String(b); }
    }
    return String(block);
  }


  /** Convert an OpenAI content value to CommandCode content blocks.
   *  Matches the Go reference proxy's `parseContent()` in convert.go — every
   *  block type the Go proxy preserves is preserved here so conversation
   *  history is never silently truncated. Image parts become CommandCode's
   *  native {type:'image', image:<url>} blocks (reference proxy + live
   *  verification 2026-09-11); the previous "[Image URL: …]" stringification
   *  discarded the image entirely. */
  private contentToBlocks(content: unknown): CCContentBlock[] {
    if (content === null || content === undefined) return [];
    if (typeof content === 'string') {
      return content.length > 0 ? [{ type: 'text', text: content }] : [];
    }
    if (Array.isArray(content)) {
      return content
        .map((c): CCContentBlock | null => {
          if (typeof c === 'string') return { type: 'text', text: c };
          const b = c as Record<string, unknown>;
          const typ = typeof b.type === 'string' ? b.type : '';

          // ── text-like blocks (Go: text, input_text, output_text, refusal,
          //     thinking, redacted_thinking, reasoning, document, search_result) ──
          if (typ === 'text' || typ === 'input_text' || typ === 'output_text' ||
              typ === 'refusal' || typ === 'thinking' || typ === 'redacted_thinking' ||
              typ === 'reasoning' || typ === 'document' || typ === 'search_result') {
            return { type: 'text', text: this.blockText(b) };
          }

          // ── image-like blocks → CC's native image part. Vision-capable
          //    models (deepseek-v4.1-flash, mimo-v2.5) see the image;
          //    non-vision models silently drop it upstream (their documented
          //    behavior, verified live) — we must not mangle it into text. ──
          if (typ === 'image_url' || typ === 'input_image' || typ === 'image') {
            const url = extractImageUrl(b);
            if (url) return { type: 'image', image: url };
            return { type: 'text', text: '[image part without url]' };
          }

          // ── tool-call blocks (Go: tool_use, tool-call) ──
          if (typ === 'tool_use' || typ === 'tool-call' || b.tool_use_id) {
            const id = (typeof b.id === 'string' ? b.id : '') ||
                       (typeof b.toolCallId === 'string' ? b.toolCallId : '') ||
                       (typeof b.tool_use_id === 'string' ? b.tool_use_id : '');
            const name = (typeof b.name === 'string' ? b.name : '') ||
                         (typeof b.toolName === 'string' ? b.toolName : '');
            const input = b.input ?? b.arguments;
            const block: CCContentBlock = { type: 'tool-call', input };
            if (id) block.toolCallId = id;
            if (name) block.toolName = name;
            return block;
          }

          // ── tool-result blocks (Go: tool_result, tool-result) ──
          if (typ === 'tool_result' || typ === 'tool-result') {
            const toolUseId = (typeof b.tool_use_id === 'string' ? b.tool_use_id : '') ||
                              (typeof b.toolCallId === 'string' ? b.toolCallId : '');
            const toolName = typeof b.toolName === 'string' ? b.toolName : '';
            const contentVal = this.blockText(b.content ?? b.output);
            const outputType = contentVal.startsWith('Error:') ? 'error-text' : 'text';
            const block: CCContentBlock = {
              type: 'tool-result',
              output: { type: outputType, value: contentVal },
            };
            if (toolUseId) block.toolCallId = toolUseId;
            if (toolName) block.toolName = toolName;
            return block;
          }

          // ── fallthrough: unknown types become text ──
          return { type: 'text', text: this.blockText(b) };
        })
        .filter((b): b is CCContentBlock => b !== null);
    }
    return [];
  }

  private convertTools(tools?: ChatToolDefinition[]): Record<string, unknown>[] {
    if (!tools || tools.length === 0) return [];
    return tools
      .filter(t => t.type === 'function' && t.function?.name)
      .map(t => {
        const out: Record<string, unknown> = {
          name: t.function.name,
          input_schema: t.function.parameters ?? { type: 'object', properties: {} },
        };
        if (t.function.description) out.description = t.function.description;
        return out;
      });
  }

  private async collectNonStreamResponse(res: Response, modelId: string): Promise<ChatCompletionResponse> {
    const events = await this.readNdjsonEvents(res);
    let content = '';
    let reasoning = '';
    const toolCalls: ChatToolCall[] = [];
    const toolCallBySlot: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;

    for (const event of events) {
      switch (event.type) {
        case 'text-delta':
          content += event.text ?? '';
          break;
        case 'reasoning-delta':
        case 'reasoning-deltas':
        case 'reasoning': {
          const r = extractReasoningFromEvent(event);
          if (r) reasoning = reasoning ? `${reasoning}\n${r}` : r;
          break;
        }
        case 'tool-use':
          toolCallBySlot[event.toolCallId!] = toolCalls.length;
          toolCalls.push({ id: event.toolCallId!, type: 'function', function: { name: event.toolName ?? '', arguments: '' } });
          break;
        case 'tool-delta':
          if (toolCalls.length > 0) toolCalls[toolCalls.length - 1].function.arguments += event.text ?? '';
          break;
        case 'tool-input-start':
          toolCallBySlot[event.id!] = toolCalls.length;
          toolCalls.push({ id: event.id!, type: 'function', function: { name: event.toolName ?? '', arguments: '' } });
          break;
        case 'tool-input-delta':
          if (event.id && toolCallBySlot[event.id] !== undefined) {
            toolCalls[toolCallBySlot[event.id]].function.arguments += event.delta ?? '';
          }
          break;
        case 'tool-call': {
          const args = event.input ? JSON.stringify(event.input) : '';
          const idx = event.toolCallId ? toolCallBySlot[event.toolCallId] : undefined;
          if (idx !== undefined) {
            if (event.toolName) toolCalls[idx].function.name = event.toolName;
            if (args) toolCalls[idx].function.arguments = args;
          } else {
            toolCalls.push({ id: event.toolCallId!, type: 'function', function: { name: event.toolName ?? '', arguments: args } });
          }
          break;
        }
        case 'finish':
          if (event.totalUsage) {
            normalizeUsage(event.totalUsage);
            inputTokens = event.totalUsage.inputTokens;
            outputTokens = event.totalUsage.outputTokens;
          }
          break;
      }
    }

    const hasToolCalls = toolCalls.length > 0;
    const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
    const msg: { role: string; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string } = {
      role: 'assistant',
      content: hasToolCalls ? null : content,
    };
    if (hasToolCalls) msg.tool_calls = toolCalls;
    if (reasoning.length > 0) msg.reasoning_content = reasoning;

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, message: msg as ChatCompletionResponse['choices'][0]['message'], finish_reason: finishReason }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  // ── Streaming ──────────────────────────────────────────────────────────

  private async *streamNdjsonResponse(res: Response, modelId: string, abortSignal?: AbortSignal): AsyncGenerator<ChatCompletionChunk> {
    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let sentRole = false;
    let toolCallIndex = 0;
    const toolCallSlot: Record<string, number> = {};
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buf = '';

    if (abortSignal?.aborted) throw new RequestAbortError();
    const { abortPromise, isAborted, cleanup } = createAbortRace(abortSignal);

    try {
      while (true) {
        if (isAborted()) throw new RequestAbortError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('CommandCode stream stalled')), STREAM_TIMEOUT_MS);
          }),
          ...(abortPromise ? [abortPromise] : []),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result;
        if (done) {
          buf += decoder.decode();
          yield* this.flushStreamBuffer(buf, id, created, modelId, () => sentRole, (v) => { sentRole = v; }, toolCallSlot, () => toolCallIndex, (v) => { toolCallIndex = v; });
          break;
        }

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const chunk = this.processStreamLine(line, id, created, modelId, () => sentRole, (v) => { sentRole = v; }, toolCallSlot, () => toolCallIndex, (v) => { toolCallIndex = v; });
          if (chunk) yield chunk;
        }
      }
    } finally {
      cleanup();
      reader.cancel().catch(() => {});
    }
  }

  private *flushStreamBuffer(
    buf: string,
    id: string, created: number, modelId: string,
    getRole: () => boolean, setRole: (v: boolean) => void,
    toolCallSlot: Record<string, number>,
    getIdx: () => number, setIdx: (v: number) => void,
  ): Generator<ChatCompletionChunk> {
    for (const line of buf.split('\n')) {
      const chunk = this.processStreamLine(line, id, created, modelId, getRole, setRole, toolCallSlot, getIdx, setIdx);
      if (chunk) yield chunk;
    }
  }

  private processStreamLine(
    line: string,
    id: string, created: number, modelId: string,
    getRole: () => boolean, setRole: (v: boolean) => void,
    toolCallSlot: Record<string, number>,
    getIdx: () => number, setIdx: (v: number) => void,
  ): ChatCompletionChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const event = this.safeParseJson(trimmed) as CCStreamEvent | null;
    if (!event || !event.type) return null;
    switch (event.type) {
      case 'text-delta': {
        const delta: StreamingDelta = { content: event.text };
        if (!getRole()) { delta.role = 'assistant'; setRole(true); }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'reasoning-delta':
      case 'reasoning-deltas':
      case 'reasoning':
      case 'thinking-delta': {
        const text = extractReasoningFromEvent(event);
        if (text.length === 0) return null;
        const delta: StreamingDelta = { reasoning_content: text };
        if (!getRole()) { delta.role = 'assistant'; setRole(true); }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'tool-use': {
        const idx = getIdx();
        toolCallSlot[event.toolCallId!] = idx;
        // H11: increment like tool-input-start/tool-call do — without this,
        // every tool-use shares index 0 and tool-delta's prevIdx computes
        // -1, silently dropping ALL streamed tool arguments.
        setIdx(idx + 1);
        const tc: StreamingToolDelta = { index: idx, id: event.toolCallId!, type: 'function', function: { name: event.toolName } };
        const delta: StreamingDelta = { tool_calls: [tc] };
        if (!getRole()) { delta.role = 'assistant'; setRole(true); }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'tool-delta': {
        const prevIdx = getIdx() - 1;
        if (prevIdx < 0) return null;
        const delta: StreamingDelta = { tool_calls: [{ index: prevIdx, function: { arguments: event.text } }] };
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'tool-input-start': {
        if (toolCallSlot[event.id!] === undefined) {
          const idx = getIdx();
          toolCallSlot[event.id!] = idx;
          setIdx(idx + 1);
        }
        const idx = toolCallSlot[event.id!];
        const tc: StreamingToolDelta = { index: idx, id: event.id!, type: 'function', function: { name: event.toolName } };
        const delta: StreamingDelta = { tool_calls: [tc] };
        if (!getRole()) { delta.role = 'assistant'; setRole(true); }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'tool-input-delta': {
        const idx = toolCallSlot[event.id!] ?? getIdx();
        const delta: StreamingDelta = { tool_calls: [{ index: idx, function: { arguments: event.delta } }] };
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'tool-call': {
        if (!event.toolCallId) return null;
        if (toolCallSlot[event.toolCallId] !== undefined) return null;
        const idx = getIdx();
        toolCallSlot[event.toolCallId] = idx;
        setIdx(idx + 1);
        const args = event.input ? JSON.stringify(event.input) : '';
        const tc: StreamingToolDelta = { index: idx, id: event.toolCallId, type: 'function', function: { name: event.toolName, arguments: args } };
        const delta: StreamingDelta = { tool_calls: [tc] };
        if (!getRole()) { delta.role = 'assistant'; setRole(true); }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case 'finish': {
        const reason = this.mapFinishReason(event.finishReason);
        const usage = event.totalUsage;
        if (usage) normalizeUsage(usage);
        return {
          id, object: 'chat.completion.chunk', created, model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: reason }],
          usage: usage ? {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          } : undefined,
        };
      }
      default:
        return null;
    }
  }

  private buildChunk(
    id: string, created: number, modelId: string,
    delta: StreamingDelta, finishReason: string | null,
  ): ChatCompletionChunk {
    return {
      id, object: 'chat.completion.chunk', created, model: modelId,
      choices: [{ index: 0, delta: delta as unknown as ChatCompletionChunk['choices'][0]['delta'], finish_reason: finishReason }],
    } satisfies ChatCompletionChunk;
  }

  private mapFinishReason(reason?: string): string {
    if (reason === 'tool_calls' || reason === 'tool-calls') return 'tool_calls';
    if (reason === 'length' || reason === 'max_tokens') return 'length';
    if (reason === 'content_filter' || reason === 'content-filter') return 'content_filter';
    return 'stop';
  }

  private async readNdjsonEvents(res: Response): Promise<CCStreamEvent[]> {
    const text = await res.text();
    const events: CCStreamEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = this.safeParseJson(trimmed);
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        events.push(parsed as CCStreamEvent);
      }
    }
    return events;
  }

  private safeParseJson(raw: string): unknown {
    try { return JSON.parse(raw); } catch { return null; }
  }
}
