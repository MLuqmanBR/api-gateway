import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ModelListRow } from '@api-gateway/shared/types.js';
import { classifyError, type ErrorClass } from '../lib/error-class.js';
import { routeRequest, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, type RouteResult, getGlobalRetryLimit } from '../services/router.js';
import { markExhausted, clearExhausted } from '../services/key-exhaustion.js';
import { recordRequest, recordTokens, setCooldown, computeRetryCooldownMs } from '../services/ratelimit.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { isCacheEnabled, isCacheableTemp, isCacheBypassed, computeCacheKey, getCachedResponse, setCachedResponse, synthesizeSSE } from '../services/cache.js';
import { recordMetricsRequest, recordMetricsTokens } from '../services/metrics.js';
import { acquireSlot, isQueueEnabled, QueueTimeoutError } from '../services/queue.js';
import { isCircuitOpen, recordCircuitSuccess, recordCircuitFailure, shouldMarkExhausted } from '../services/circuit-breaker.js';
import { setRetryAfter } from '../lib/http-headers.js';
import { getDb, getUnifiedApiKey, cachedPrepare } from '../db/index.js';
import { authenticateClientKey, type AuthenticatedClientKey } from '../lib/client-keys.js';
import { checkAndReserve, recordSpend, releaseBudget, estimateCostCents } from '../services/budgets.js';
import { contentToString, messageHasImage, normalizeOutboundContent } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { applyThinkingPolicy, resolveThinkingPolicy, parseStoredThinkingLevels, THINKING_LEVELS } from '../lib/thinking.js';
import { ThinkTagStream } from '../lib/think-tags.js';
import { getContextHandoffMode, recordIncomingMessages, recordSuccessfulModel, hasPriorModel, HANDOFF_MAX_TOKENS } from '../services/context-handoff.js';
import { pipeline } from '../lib/hook-pipeline.js';
import { registerBuiltInHooks } from '../lib/builtin-hooks.js';
import { applyOutbound, unredactResponseText, createStreamUnredactor, interceptInboundText, type MiddleSession } from '../middle/index.js';

// F1: register the three built-in transforms (context-handoff, tool-rescue,
// think-tags) on the process-wide HookPipeline singleton. Idempotent — safe
// even if responses.ts also calls it. F7/F8 subscribe to this pipeline.
registerBuiltInHooks();
import { publish } from '../services/events.js';
import { attachClientAbort, abortableSleep, isAbortError } from '../lib/abort.js';
import { resolvePinnedModel, formatPinnedModelRejection } from '../lib/pinned-model.js';
import { isReasoningModelId } from '../lib/reasoning-model.js';
import { logger } from '../lib/logger.js';

export const proxyRouter = Router();

// Virtual "auto" model. Clients like Hermes require a non-empty `model` field
// on every request, but api-gateway's whole point is to pick the model itself.
// Requesting this id means "let the router decide" — identical to omitting
// `model` entirely.
const AUTO_MODEL_ID = 'auto';

function isAutoModel(modelId: string | undefined): boolean {
  return modelId === AUTO_MODEL_ID;
}

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
export function timingSafeStringEqual(provided: string, expected: string): boolean {
  // Use HMAC to produce fixed-length digests so timingSafeEqual always
  // receives same-length buffers regardless of input length. This eliminates
  // both the per-character timing leak and the length-branch timing leak that
  // the Buffer.alloc-on-mismatch approach had.
  const key = Buffer.alloc(32);
  const a = crypto.createHmac('sha256', key).update(provided).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Extract the unified API key from an incoming request. Accepts both the
// OpenAI-style `Authorization: Bearer <key>` header and the Anthropic-style
// `x-api-key` header. Clients that speak the Anthropic wire format — notably
// Claude Code routed through CC Switch (#103) — send the key in `x-api-key`
// rather than a bearer token, and were getting a spurious "Invalid API key"
// 401 before this fallback existed.
export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  return trimmed || undefined;
}

// F3: authenticate a request token against the unified key (backward-compat)
// OR a client key (scoped, hashed-at-rest). Returns the authenticated client
// key info if the token is a client key; null for the unified key. The caller
// uses the returned clientKey to enforce model allowlist + expiry inside
// routeRequest. An empty client_keys table means only the unified key works.
export interface AuthResult {
  authenticated: boolean;
  clientKey: AuthenticatedClientKey | null;
}
export function authenticateRequest(token: string | undefined): AuthResult {
  if (!token) return { authenticated: false, clientKey: null };
  const unifiedKey = getUnifiedApiKey();
  // Unified key first (backward-compat — the bootstrap credential).
  if (timingSafeStringEqual(token, unifiedKey)) {
    return { authenticated: true, clientKey: null };
  }
  // Client key: <key_id>:<secret> format. O(1) PK lookup + one scrypt.
  const clientKey = authenticateClientKey(token);
  if (clientKey) {
    return { authenticated: true, clientKey };
  }
  return { authenticated: false, clientKey: null };
}

// Sticky sessions: track which model served each "session"
// Key: <api_key>:<session_hash> → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionEnabled = (process.env.STICKY_SESSION_ENABLED ?? 'true') !== 'false';
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[], sessionIdHeader?: string): string {
  // Explicit session pinning: clients that manage their own conversation ids
  // (agent harnesses especially) can send X-Session-Id and get exact
  // affinity regardless of how their message history mutates. (#231)
  if (sessionIdHeader) return `hdr:${sessionIdHeader}`;

  // Otherwise the first user message identifies the session — clients re-send
  // the full conversation each turn, so it is stable across turns. Flatten
  // array-of-blocks content before hashing: opencode-style agents send
  // [{type:'text',...}] even for plain text, and the old string-only check
  // silently disabled stickiness for them, re-routing every turn (#231 audit:
  // observed a rank-2 → rank-11 mid-conversation flip). No turn-count suffix:
  // the old ':single'/':multi' split guaranteed a sticky MISS on turn 2,
  // exactly where agents replay the assistant's tool-call dialect and a model
  // switch causes cross-dialect contamination.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  return crypto.createHash('sha1').update(text).digest('hex');
}

function getSessionKeyWithApiKey(apiKey: string | undefined, messages: ChatMessage[], sessionIdHeader?: string): string {
  // When sticky sessions are enabled, include the API key in the session key
  // to make sessions per-API-key instead of global.
  const sessionKey = getSessionKey(messages, sessionIdHeader);
  if (!sessionKey) return '';
  if (!apiKey) return sessionKey;
  return `${apiKey}:${sessionKey}`;
}

export function getStickyModel(apiKey: string | undefined, messages: ChatMessage[], sessionIdHeader?: string): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  // Skip if sticky sessions are disabled
  if (!stickySessionEnabled) return undefined;

  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKeyWithApiKey(apiKey, messages, sessionIdHeader);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(apiKey: string | undefined, messages: ChatMessage[], modelDbId: number, sessionIdHeader?: string) {
  // Only apply sticky if enabled
  if (!stickySessionEnabled) return;

  const key = getSessionKeyWithApiKey(apiKey, messages, sessionIdHeader);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries — sweep expired, then evict oldest until under cap.
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
    while (stickySessionMap.size > 500) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of stickySessionMap) {
        if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
      }
      stickySessionMap.delete(oldestKey);
    }
  }
}

// Derive the OpenAI-completions-compatible capability block for a given
// catalog row. Capabilities are additive on top of the strict OpenAI
// `/v1/models` envelope — OpenAI's parsers ignore unknown fields, and
// clone gateways (OpenRouter/Groq/Together/etc.) do the same.
//
// Field rationale (keep aligned with `services/router.ts` / migrations):
//   - `context_window`         input token cap (already exposed pre-change).
//   - `max_tokens`             per-response output cap; matches the OpenAI
//                              chat-completions `max_tokens` request param
//                              semantics (clients read it from the listing
//                              rather than probing).
//   - `modalities.input`       ["text"] by default; ["text","image"] when
//                              `supports_vision=1`.
//   - `modalities.output`      ["text"] — none of the catalog models emit
//                              image/audio, so clients only need image-input
//                              awareness, not image-generation output flags.
//   - `capabilities.tool_calls` is always true: tool calling is assumed
//                              for every catalog model.
//   - `capabilities.vision`    mirrors `supports_vision` rule-based flag.
//   - `capabilities.json_mode` true: every chat-completions model here
//                              accepts OpenAI `response_format` (the proxy
//                              already translates that for non-OpenAI
//                              providers — see `services/responses.ts`).
//   - `capabilities.streaming` true: every chat model here supports SSE
//                              through `/v1/chat/completions?stream=true`.
//   - `capabilities.reasoning` is DATA-DRIVEN from `models.thinking_levels`:
//                              thinking enabled by default (full six-level
//                              menu); an operator subset narrows it;
//                              `["off"]` force-disables (reasoning=false,
//                              no menu). No id-pattern matching here — the
//                              dashboard is the single source of truth.
function buildModelCapabilities(
  modelId: string,
  maxOutputTokens: number | null,
  supportsVision: boolean,
  thinkingLevelsRaw: string | null,
) {
  // Thinking capability is DATA-DRIVEN, never id-pattern-matched: the
  // dashboard is the single source of truth. Untouched rows (NULL column)
  // default to thinking ENABLED with the full six-level menu; an explicit
  // subset narrows it; `["off"]` force-disables (advertised as
  // non-reasoning, no efforts field).
  const policy = resolveThinkingPolicy(thinkingLevelsRaw);

  const modalities: { input: string[]; output: string[] } = {
    input: supportsVision ? ['text', 'image'] : ['text'],
    output: ['text'],
  };

  const capabilities: {
    tool_calls: boolean;
    vision: boolean;
    json_mode: boolean;
    streaming: boolean;
    reasoning: boolean;
    reasoning_efforts?: string[];
  } = {
    tool_calls: true,
    vision: supportsVision,
    json_mode: true,
    streaming: true,
    reasoning: policy.kind !== 'off',
  };
  if (policy.kind === 'levels') {
    capabilities.reasoning_efforts = [...policy.levels];
  } else if (policy.kind === 'unrestricted') {
    capabilities.reasoning_efforts = [...THINKING_LEVELS];
  }

  return {
    // OpenAI-aligned token caps. `max_tokens` is the per-completion output
    // cap a client should send; `context_window` is the input+output cap.
    max_tokens: maxOutputTokens ?? null,
    modalities: modalities,
    capabilities: capabilities,
  };
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata) 
// shows API models which is linked by the user.
proxyRouter.get('/models', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const auth = authenticateRequest(token);
  if (!auth.authenticated) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const db = getDb();
  const models = db.prepare(`
    SELECT
      m.id, m.platform, m.model_id, m.display_name, m.context_window,
      m.max_output_tokens, m.supports_vision, m.thinking_levels,
      m.intelligence_rank
    FROM models m
    WHERE m.enabled = 1
      AND EXISTS (
        SELECT 1 FROM fallback_config fc WHERE fc.model_db_id = m.id AND fc.enabled = 1
      )
      AND EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform
          AND k.enabled = 1
      )
    ORDER BY m.intelligence_rank ASC, m.id ASC
  `).all() as ModelListRow[];

  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'api-gateway',
        name: 'Auto (router picks the best available model)',
        context_window: null,
      },
      ...models.map(m => {
        const caps = buildModelCapabilities(
          m.model_id,
          m.max_output_tokens,
          m.supports_vision === 1,
          m.thinking_levels,
        );
        return {
          id: `${m.platform}/${m.model_id}`,
          object: 'model',
          created: 0,
          owned_by: m.platform,
          name: m.display_name,
          context_window: m.context_window,
          // Extension fields below — additive on the strict OpenAI list
          // envelope. Strict SDKs ignore them; capability-aware clients
          // (Hermes, LangChain chat model pickers, OpenCode) read them.
          max_tokens: caps.max_tokens,
          modalities: caps.modalities,
          capabilities: caps.capabilities,
        };
      }),
    ],
  });
});


const PER_KEY_RETRIES = 3;

// Echo-tolerant tool calls: agents replay OUR responses back as history, and
// not all of them preserve the strict OpenAI shape. `type` may be dropped
// (re-added on forward), Gemini-lineage agents (Qwen Code, AionUI) often
// send `arguments` as a parsed object instead of a JSON string, and `id` may
// be missing or empty (ids aren't a Gemini concept) — all get normalized
// below rather than 400-ing the whole session. Missing ids are synthesized
// and paired with their tool-result messages by order. (#200)
const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  thought_signature: z.string().optional(),
});

const toolCallArgsToString = (args: string | Record<string, unknown>): string =>
  typeof args === 'string' ? args : JSON.stringify(args);

// OpenAI multimodal envelope. Clients like opencode / continue.dev send
// content as an array of typed blocks even when only text is present, and
// Gemini-lineage agents send part-style blocks like `{ "text": "..." }` with
// no `type` at all. Accept any object (or bare string) as a block; flatten to
// string for providers that don't support arrays (Cohere, Cloudflare).
// Non-text blocks pass z validation but get dropped by contentToString —
// vision/audio still isn't supported. (#200)
const contentBlockSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

// OpenAI's newer SDKs send the system prompt as role:"developer"; accept it
// and forward as "system" — none of the routed providers know the developer
// role. (#200)
const developerMessageSchema = z.object({
  role: z.literal('developer'),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

// Assistant turns may carry empty/null content and no tool_calls — OpenAI
// accepts these in conversation history (a turn that produced no visible text,
// a placeholder, a tool turn whose content was emptied), and clients replay
// them verbatim. We accept them too and coerce empty/null content to "" before
// forwarding (see message build below) rather than 400-ing a payload OpenAI
// would take. (#165)
const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  // tool_calls: null (not just missing) is what several agents replay for
  // no-tool assistant turns — aionrs (AionUI's engine) writes it into every
  // session-resumed assistant echo. Treated as absent. (#200)
  tool_calls: z.array(toolCallSchema).nullable().optional(),
  // Thinking trace echoed back by a client. DeepSeek thinking models on
  // OpenCode Zen 400 ("reasoning_content in thinking mode must be passed back")
  // unless the prior turn's reasoning_content is replayed, so keep it through
  // validation instead of stripping it. See issue #255.
  reasoning_content: z.string().nullable().optional(),
  // Anthropic thought signature — providers need both `reasoning_content`
  // and this paired signature to fully reconstruct the prior turn's
  // extended-thinking on a multi-turn tool loop. (#290)
  thinking_signature: z.string().nullable().optional(),
});

// Tool results may arrive with null/missing content (a tool that returned
// nothing) and a missing/empty tool_call_id (Gemini-lineage agents) — coerced
// to "" and paired by order with the preceding tool_calls respectively. (#200)
const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([contentSchema, z.null()]).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

// Legacy function-calling shape (pre-tools OpenAI API). Old clients still
// replay these in history; forwarded as a tool message. (#200)
const functionMessageSchema = z.object({
  role: z.literal('function'),
  name: z.string().min(1),
  content: z.union([contentSchema, z.null()]).optional(),
});

const toolDefinitionSchema = z.object({
  // Some agents omit `type` on tool definitions; re-defaulted to 'function'
  // on forward. (#200)
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});
const toolChoiceSchema = z.union([
  // 'any' is the Mistral/Gemini wording for OpenAI's 'required'; mapped on
  // forward. (#200)
  z.enum(['none', 'auto', 'required', 'any']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

// Linear thinking-effort scale accepted across all platforms. Providers map
// this to their native vocab (`thinking.level`, `reasoning_effort`,
// `output_config.effort`, etc.). `xhigh` is Anthropic-only; providers that
// don't recognize it collapse to `high`. (#290)
const thinkingEffortSchema = z.enum(['max', 'xhigh', 'high', 'medium', 'low', 'minimal']);

// Richer thinking-control object. Providers translate this into their native
// wire shape on the way out. (#290)
const thinkingConfigSchema = z.object({
  type: z.enum(['enabled', 'adaptive', 'disabled']).optional(),
  effort: thinkingEffortSchema.optional(),
  budget: z.number().int().nonnegative().optional(),
  display: z.enum(['summarized', 'omitted']).optional(),
  includeThoughts: z.boolean().optional(),
});

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    developerMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
    functionMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Some clients send max_tokens <= 0 (or -1) to mean "no limit"; accepted and
  // treated as unset on forward. (#200)
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  // Top-level tool knobs may arrive as explicit nulls from clients that
  // serialize every field of their request struct; all treated as absent
  // and never forwarded as null. (#200)
  tools: z.array(toolDefinitionSchema).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  // Thinking controls — either the shorthand `reasoning_effort` or the
  // richer `thinking` object is honored; provider code translates them
  // into the wire shape each upstream accepts. (#290)
  // The six effort levels, plus the literal 'off' — clients use it to mean
  // "do not think this turn"; normalized into thinking:{type:'disabled'} at
  // the destructure site below. (#thinking-off)
  reasoning_effort: z.union([thinkingEffortSchema, z.literal('off')]).nullable().optional(),
  thinking: thinkingConfigSchema.nullable().optional(),
  // F5: per-request cache control. `cache: {no_cache: true}` bypasses the
  // response cache for this single request (litellm's per-request pattern).
  cache: z.object({
    no_cache: z.boolean().optional(),
    ttl: z.number().int().min(0).optional(),
  }).nullable().optional(),
});
export function isRetryableError(err: any): boolean {
  // First check structured status (set by providerHttpError in base.ts).
  // If present, it's authoritative — matches the same categories as the
  // message heuristics below, but without parsing ambiguity.
  if (typeof err?.status === 'number') {
    // Transient/retriable HTTP status codes (matching message heuristics).
    // 400 is included because providers often return 400 for bad API keys
    // (per-key error) — the key rotation logic expects this to be retryable
    // so it can cycle to the next key on the same model.
    if (err.status === 400 || err.status === 429 || err.status === 408 || err.status === 425 ||
        err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504 ||
        err.status === 403 || err.status === 404) {
      return true;
    }
    // Non-retryable statuses: 401 (auth), 402 (payment - handled by isPaymentRequiredError), etc.
    return false;
  }
  // Fallback: message-based heuristics (legacy path, keeps existing behavior).
  const msg = (err.message ?? '').toLowerCase();
  return /\b429\b/.test(msg) || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || /\b503\b/.test(msg) || msg.includes('unavailable')
    || /\b500\b/.test(msg) || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || /\b413\b/.test(msg) || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || /\b404\b/.test(msg) || msg.includes('not found') || msg.includes('no endpoints found')
    // 403: the key is valid (passed validateKey, health checker disables
    // truly-forbidden keys) but this specific model is off-limits to the
    // key's tier. The normal retry path exhausts this key after
    // PER_KEY_RETRIES, marks it exhausted, and rotates to a sibling key
    // on the same model; if no siblings survive, the outer loop moves to
    // the next model. Cooldown uses the standard computeRetryCooldownMs
    // — no special day-long bench. See issue #256.
    || /\b403\b/.test(msg) || msg.includes('forbidden') || (err?.status === 403)
    // 400: one provider may reject parameters another accepts (e.g. max_tokens
    // limits, unsupported params). The matching pattern is "api error 400"
    // which comes from the OpenAI-compat provider's error formatting, not
    // a bare "400" which is deliberately non-retryable for validation errors.
    || msg.includes('api error 400')
    // 402: this provider/key is out of credits (e.g. HuggingFace Router
    // "API error 402: Payment required"). The SAME model often lives on another
    // provider (Kimi K2.6 is on HF + Cloudflare + NVIDIA), so fail over instead
    // of killing the workflow. Paired with a long cooldown (isPaymentRequiredError)
    // so we don't re-hammer the broke key every retry.
    || isPaymentRequiredError(err)
    // Dead-turn classes from the stream turn-integrity layer (#231 audit):
    // all thrown before any byte reached the client, so another model can
    // serve the request invisibly.
    || msg.includes('empty completion')
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('unparseable inline tool-call dialect');
}

// A 402 Payment Required / out-of-credits error. Distinct from a transient 429:
// it won't recover on the next window. X1: cooldown is flat 90s like every
// other error — the predicate STAYS for routing (a 402 falls over to the next
// model via isRetryableError) and for C1 cooldown-reason recording.
export function isPaymentRequiredError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return /\b402\b/.test(msg) || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

// Genuine upstream rate-limit 429 (structured status first, message
// heuristic fallback). Shared by the proxy's keyRetry backoff and the
// responses retry loop so both paths classify identically.
export function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return status === 429 || /\b429\b/.test(msg)
    || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('resource_exhausted');
}

/** C1: classify the cooldown reason from the error for debug metadata.
 *  Does NOT affect cooldown duration (flat 90s via X1). */
export function classifyCooldownReason(err: any): { reason: string; statusCode?: number } {
  if (!err) return { reason: 'unknown' };
  const status = typeof err.status === 'number' ? err.status : undefined;
  if (isPaymentRequiredError(err)) return { reason: 'payment_required', statusCode: status ?? 402 };
  if (status === 429) return { reason: 'rate_limit', statusCode: 429 };
  if (status && status >= 500) return { reason: 'server_error', statusCode: status };
  if (status && status >= 400) return { reason: 'client_error', statusCode: status };
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return { reason: 'timeout' };
  if (msg.includes('abort')) return { reason: 'aborted' };
  return { reason: 'transport_error', statusCode: status };
}

// Pull the incremental text out of a streaming chunk for token counting.
// Must tolerate chunks that carry no `choices` array at all: some providers
// (e.g. Groq) emit usage/keepalive frames shaped like `{usage:{...}}` with no
// `choices`. Indexing `chunk.choices[0]` on those throws "Cannot read
// properties of undefined (reading '0')", which — once the SSE stream has
// started — aborts the response mid-flight with no chance to fall back.
export function streamChunkText(chunk: any): string {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

// OpenAI-compatible embeddings endpoint, routed through the embeddings family
// catalog: `model: "auto"` (or omitted) → the configured default family; a
// family name or provider model id → that family's provider chain. Failover
// only happens WITHIN a family (same model on another provider) — never across
// models, since vectors from different models are incompatible.
const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
});

proxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const auth = authenticateRequest(token);
  if (!auth.authenticated) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
  const parsed = EmbeddingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs);
    res.json({
      object: 'list',
      data: result.vectors.map((values, i) => ({ object: 'embedding', index: i, embedding: values })),
      model: result.family,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `embedding error: ${err?.message ?? 'unknown'}`, type } });
  }
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate with the unified API key for every proxy request, including
  // loopback callers. Browser pages can reach localhost, so socket locality is
  // not a reliable authorization boundary.
  const token = extractApiToken(req);
  const auth = authenticateRequest(token);
  if (!auth.authenticated) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    // Path-qualified issues ("messages.1.content: Invalid input" beats a bare
    // "Invalid input") and a server-side breadcrumb — these rejections never
    // reach the request log, which made #200 nearly undebuggable.
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    console.warn(`[proxy] 400 invalid /chat/completions request: ${detail}`);
    res.status(400).json({
      error: {
        message: `Invalid request: ${detail}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const {
    model: requestedModel, temperature, top_p, stream,
    reasoning_effort: inboundReasoningEffort,
    thinking: inboundThinking,
  } = parsed.data;
  // Agent-tolerant knob normalization (#200): max_tokens <= 0 means "no
  // limit" in several clients → unset; tool_choice 'any' is OpenAI's
  // 'required'; tool definitions get their 'function' type re-defaulted.
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : undefined;
  const tool_choice = parsed.data.tool_choice === 'any' ? 'required' as const : parsed.data.tool_choice ?? undefined;
  const tools = parsed.data.tools?.map(t => ({ ...t, type: 'function' as const }));
  const parallel_tool_calls = parsed.data.parallel_tool_calls ?? undefined;
  // Build the per-call thinking view once; providers receive it through
  // CompletionOptions. Explicit nulls are normalized to undefined so the
  // provider-side `if (options?.reasoning_effort)` pattern works. (#290)
  // The client shorthand 'off' means "do not think this turn": folded into
  // the existing explicit-disable representation so policy checks, cache
  // keys, pass-through spreads, and provider emitters all see one shape.
  // Top-level 'off' wins over any contradictory thinking-object fields.
  const reasoning_effort = inboundReasoningEffort === 'off'
    ? undefined
    : inboundReasoningEffort ?? undefined;
  const thinking = inboundReasoningEffort === 'off'
    ? { ...(inboundThinking ?? {}), type: 'disabled' as const, effort: undefined }
    : inboundThinking ?? undefined;
  // Pairing state for id-less tool calls (#200): every tool_call id (given or
  // synthesized) queues up here; a tool message without a tool_call_id takes
  // the oldest unanswered one, which matches the single-call-per-turn flow
  // Gemini-lineage agents produce.
  const pendingToolCallIds: string[] = [];
  let syntheticIdCounter = 0;
  const takeToolCallId = (given: string | undefined): string => {
    if (given && given.length > 0) {
      const qi = pendingToolCallIds.indexOf(given);
      if (qi !== -1) pendingToolCallIds.splice(qi, 1);
      return given;
    }
    return pendingToolCallIds.shift() ?? `call_auto_${++syntheticIdCounter}`;
  };

  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      const hasToolCalls = (m.tool_calls?.length ?? 0) > 0;
      // With tool_calls, content: null is the correct OpenAI shape — keep it.
      // Without tool_calls, coerce empty/null content to "" so strict upstreams
      // don't choke on a null-content assistant turn we just accepted. (#165)
      const isEmptyContent = m.content == null
        || (typeof m.content === 'string' && m.content.length === 0)
        || (Array.isArray(m.content) && m.content.length === 0);
      const assistantContent: ChatMessage['content'] = hasToolCalls
        ? (m.content ?? null)
        : (isEmptyContent ? '' : m.content!);
      return {
        role: 'assistant',
        content: assistantContent,
        ...(m.name ? { name: m.name } : {}),
        // Replay the thinking trace verbatim. DeepSeek thinking models on
        // OpenCode Zen reject a follow-up turn that drops it; other providers
        // ignore the unknown field. Same round-trip rationale as
        // thought_signature below. (#255)
        ...(typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0
          ? { reasoning_content: m.reasoning_content }
          : {}),
        // Paired with `reasoning_content` so providers that need an encrypted
        // signature to reconstruct the prior thinking block on a multi-turn
        // tool loop (Anthropic, Gemini 3) receive it without the client
        // having to ship a separate protocol. (#290)
        ...(typeof m.thinking_signature === 'string' && m.thinking_signature.length > 0
          ? { thinking_signature: m.thinking_signature }
          : {}),
        // hasToolCalls (not a bare truthiness check) so null AND empty-array
        // tool_calls are dropped rather than forwarded — strict upstreams
        // reject both shapes. (#200)
        ...(hasToolCalls ? { tool_calls: m.tool_calls!.map(tc => {
          // Normalize echo-tolerant inputs back to the strict OpenAI shape
          // before forwarding (see toolCallSchema); synthesize missing ids
          // and queue every id for order-based tool-result pairing. (#200)
          const id = tc.id && tc.id.length > 0 ? tc.id : `call_auto_${++syntheticIdCounter}`;
          pendingToolCallIds.push(id);
          return {
            id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: toolCallArgsToString(tc.function.arguments) },
            thought_signature: tc.thought_signature,
          };
        }) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        // Null/missing content (a tool that returned nothing) → "". (#200)
        content: m.content ?? '',
        tool_call_id: takeToolCallId(m.tool_call_id),
        ...(m.name ? { name: m.name } : {}),
      };
    }

    // Legacy function-calling result → forward as a tool message, paired by
    // order like an id-less tool message. (#200)
    if (m.role === 'function') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: takeToolCallId(undefined),
        name: m.name,
      };
    }

    return {
      // 'developer' is OpenAI's newer name for the system role — providers
      // downstream only know 'system'. (#200)
      role: m.role === 'developer' ? 'system' : m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = contentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);

  // Image requests must route to a vision-capable model. Reject up front with a
  // clear message when none is enabled, rather than silently dropping the image
  // or surfacing the generic "all models exhausted" error (#118, #125). Add a
  // rough per-image token cost so budget routing isn't skewed by content the
  // heuristic above (text-only) can't see.
  const hasImage = messageHasImage(messages);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes an image, but no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }
  const IMAGE_TOKEN_ESTIMATE = 1000;
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => (b as { type?: string })?.type === 'image_url' || (b as { type?: string })?.type === 'image').length : 0), 0);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + (max_tokens ?? 1000);



  // Optional client-managed session affinity (see getSessionKey). Express
  // lower-cases header names; a repeated header arrives as an array — take
  // the first value.
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  // Context handoff only applies to auto-routed requests. Pinned-model requests
  // are deliberate client choices; injecting "you are taking over" there would
  // be semantically wrong.
  const isAutoRouted = !requestedModel || isAutoModel(requestedModel);
  const handoffMode = isAutoRouted ? getContextHandoffMode() : ('off' as const);
  // sessionKey is computed unconditionally — sticky-keys routing needs it
  // regardless of handoff mode, since they're independent features.
  const sessionKey = getSessionKey(messages, sessionIdHeader);
  if (handoffMode !== 'off' && sessionKey) {
    recordIncomingMessages(sessionKey, messages);
  }
  // A handoff can only fire when a prior model is on record for this session.
  // Check after recordIncomingMessages, which clears the prior model on a
  // fresh conversation. Stable across the retry loop (the prior model only
  // changes on a success, which returns), so compute it once here.
  const handoffPossible = handoffMode !== 'off' && !!sessionKey && hasPriorModel(sessionKey);

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  if (isAutoModel(requestedModel)) {
    // Explicit "auto" → behave exactly like an omitted model field.
    preferredModel = getStickyModel(token, messages, sessionIdHeader);
  } else if (requestedModel) {
    const db = getDb();
    const resolution = resolvePinnedModel(db, requestedModel);
    if (resolution.kind === 'resolved') {
      preferredModel = resolution.modelDbId;
    } else {
      const reason = formatPinnedModelRejection(resolution);
      res.status(400).json({
        error: {
          message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(token, messages, sessionIdHeader);
  }

  // For analytics: the model id the client pinned, null when auto-routed
  // ('auto' or omitted). Logged with every request row so pinned vs auto
  // traffic and failover overrides are visible.
  const pinnedModelId: string | undefined = requestedModel && !isAutoModel(requestedModel) ? requestedModel : undefined;
  const requestId = crypto.randomUUID();
  publish({ type: 'request.start', id: requestId, model: pinnedModelId, stream: !!stream, at: Date.now() });

  // Client-disconnect abort wiring. The controller's signal is threaded into
  // every upstream provider call AND every sleep in the retry loop, so a Stop
  // / session-close cancels the in-flight request immediately and breaks out
  // of the loop instead of grinding through recovery cycles. The watcher only
  // fires on a REAL disconnect (close before `res.end()`), not normal
  // completion. (#292)
  const { controller: abortController, detach: detachAbortWatcher } = attachClientAbort(res);
  const abortSignal = abortController.signal;

  // Retry loop: per-key 3-retry followed by model/key cycling.
  // In 1 RPM mode (after all keys/models are exhausted), retries are
  // throttled to 1 request/minute for the globally-configured number of
  // cycles (0 = infinite).
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;
  // F2 (β): typed fallback routing — tracks the error class from the last
  // retryable failure so the next routeRequest skips models that would fail
  // the same way (e.g. escalate to a bigger-context model on context overflow).
  let triggeringClass: ErrorClass | undefined;
  let failedContextWindow: number | null | undefined;
  let failedModelDbId: number | undefined;
  // F12: track the unique model ids the router attempted for the response header.
  const attemptedModels = new Set<string>();
  const isPinned = !!(requestedModel && !isAutoModel(requestedModel));
  let prevModelKey: string | undefined;
  let prevKeyId: number | undefined;
  let inOneRPMMode = false;
  let oneRPMCycles = 0;
  let lastRequestTime = 0;
  const globalRetryMax = getGlobalRetryLimit();
  // Total upstream call counter. The global recovery limit (user setting)
  // counts ACTUAL upstream attempts, not "cycles" — so a limit of 10 means at
  // most 10 provider calls across every key/model, enforced from the first
  // retry rather than only once 1-RPM recovery kicks in. `0` = infinite, but
  // the loop is still interruptible by a client disconnect. (#292)
  let upstreamAttempts = 0;
  // §11.6: set when an upstream attempt failed with a 400-class error. At
  // chain exhaustion this distinguishes "every route rejected this request"
  // (likely a client-side malformed request) from a provider outage.
  let sawUpstream400 = false;

  // Client-disconnect detection: if the agent presses Stop or closes the
  // session, abort the whole retry/recovery loop instead of grinding through
  // 1-RPM cycles forever. The abort signal (wired via `req.on('close')` in
  // `attachClientAbort`) fires the instant the socket tears down — event-driven,
  // not polled, so a disconnect during a 60s sleep or an in-flight fetch is
  // caught immediately and the loop exits. The watcher ignores the `close`
  // that fires after a normal `res.end()` so successful completions are
  // unaffected. (#292)
  // F5: Response cache — check for a cache hit before entering the routing
  // loop. Only temperature === 0 (deterministic) requests are cacheable, and
  // only when cache_enabled is true (default). Bypass via `cache:{no_cache}`
  // in the request body or `X-API-Gateway-No-Cache` header.
  const cacheNoCacheHeader = req.get('X-API-Gateway-No-Cache');
  const cacheDirective = parsed.data.cache;
  // C3: parse request tags from X-API-Gateway-Tags header for tag-based filtering.
  const rawTagsHeader = req.headers['x-api-gateway-tags'] as string | string[] | undefined;
  const tagsHeader = Array.isArray(rawTagsHeader) ? rawTagsHeader[0] : rawTagsHeader;
  const reqTags = tagsHeader
    ? new Set(tagsHeader.split(',').map(t => t.trim()).filter(Boolean))
    : undefined;
  const cacheable = isCacheEnabled()
    && isCacheableTemp(temperature, top_p)
    && !isCacheBypassed(cacheDirective, cacheNoCacheHeader);
  let cacheKey: string | undefined;
  if (cacheable) {
    cacheKey = computeCacheKey({
      model: requestedModel ?? 'auto', messages, tools, tool_choice,
      temperature, top_p, max_tokens, reasoning_effort, thinking, parallel_tool_calls,
    });
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      const sse = stream ? synthesizeSSE(cached) : null;
      if (stream && sse !== null) {
        // Synthesize SSE from the cached non-streaming JSON (OmniRoute pattern).
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        res.write(sse);
        res.end();
      } else {
        // M04: tool_calls can't be faithfully replayed as SSE; fall back to
        // the non-streaming JSON envelope even for a streaming request. A
        // stream-requesting client gets the full tool_calls payload, which
        // is strictly better than an SSE replay that silently drops them.
        if (stream) res.setHeader('X-Cache-Fallback', 'tool-calls');
        res.setHeader('Cache-Control', 'no-cache');
        res.json(JSON.parse(cached));
      }
      publish({ type: 'request.done', id: requestId, model: requestedModel ?? 'auto', provider: 'cache', keyId: 0, latencyMs: Date.now() - start, tokens: { in: 0, out: 0 }, at: Date.now() });
      // M03: the response is already ended; detach the client-abort watcher
      // so its `close` listener doesn't outlive the request.
      detachAbortWatcher();
      return;
    }
    // Cacheable but no hit — mark MISS so the client can see the cache is active.
    res.setHeader('X-Cache', 'MISS');
  }

  // B2-6: per-request middle-layer session. Created lazily by applyOutbound
  // on the first enabled attempt; reused across retries/fallbacks so the
  // AI interceptor (Stage-2) runs once per request, not per attempt.
  let middleSession: MiddleSession | undefined;

  // F4: estimated cost in cents for budget tracking (0 when no client key
  // or no budget row). Set by the budget check after route selection.
  // Declared OUTSIDE the try so the finally can release an outstanding
  // reservation on any exit (C02).
  let budgetEstCostCents = 0;
  let budgetPricing: { actual_cost_input_per_m: number | null; actual_cost_output_per_m: number | null; paid_input_per_m: number | null; paid_output_per_m: number | null } | undefined;
  // C02: true while a checkAndReserve estimate is outstanding (reserved but
  // not yet reconciled by recordSpend). Every exit that doesn't settle must
  // releaseBudget() — phantom reservations permanently inflate budgets.
  let budgetOpen = false;

  try {
  outerLoop: for (let totalAttempt = 0; ; totalAttempt++) {
    // ---- Exit: client disconnected ----
    if (abortSignal.aborted) {
      publish({ type: 'request.aborted', id: requestId, at: Date.now() });
      return;
    }
    // ---- Exit: global attempt limit reached ----
    // Counts ACTUAL upstream attempts (every provider call), enforced from the
    // very first retry — not only once 1-RPM recovery kicks in. `0` (the
    // "infinite" setting) disables the cap but the loop is still interruptible
    // by the client-disconnect abort above. Previously this only ran in 1-RPM
    // mode and counted "cycles" (1 cycle = up to PER_KEY_RETRIES × keys ×
    // models upstream calls), so a limit of 10 could produce 100+ requests and
    // never tripped until everything was already exhausted. (#292)
    //
    // Safety net: when routing itself keeps failing (e.g. no keys configured —
    // `routeRequest` throws before any upstream call is ever made), the
    // upstream counter never moves. The loop iteration counter (`totalAttempt`)
    // bounds that path so a no-keys request still returns instead of looping
    // forever. The bound is the same `globalRetryMax` scaled to give each
    // configured cycle a fair shot. (#292)
    if (globalRetryMax > 0 && upstreamAttempts >= globalRetryMax) {
      const msg = `Recovery limit reached after ${upstreamAttempts} upstream attempt(s). Last: ${sanitizeProviderErrorMessage(lastError?.message)}`;
      publish({ type: 'request.error', id: requestId, error: msg, at: Date.now() });
      if (!res.headersSent) {
        res.setHeader('X-Routed-Via', 'none');
        if (attemptedModels.size > 0) res.setHeader('X-Attempted-Models', [...attemptedModels].join(','));
        res.setHeader('X-Upstream-Attempts', String(upstreamAttempts));
        res.status(429).json({
          error: {
            message: msg,
            type: 'rate_limit_error',
          },
        });
      }
      return;
    }
    if (globalRetryMax > 0 && totalAttempt >= globalRetryMax) {
      const msg = `All models rate-limited after ${totalAttempt} recovery iteration(s). Last: ${sanitizeProviderErrorMessage(lastError?.message)}`;
      publish({ type: 'request.error', id: requestId, error: msg, at: Date.now() });
      if (!res.headersSent) {
        res.setHeader('X-Routed-Via', 'none');
        if (attemptedModels.size > 0) res.setHeader('X-Attempted-Models', [...attemptedModels].join(','));
        res.setHeader('X-Recovery-Iterations', String(totalAttempt));
        res.status(429).json({
          error: {
            message: msg,
            type: 'rate_limit_error',
          },
        });
      }
      return;
    }

    // ---- 1 RPM throttling ----
    if (inOneRPMMode && lastRequestTime > 0) {
      const elapsed = Date.now() - lastRequestTime;
      if (elapsed < 60_000) {
        // Abortable: a client disconnect during the 60s wait rejects
        // immediately instead of running out the clock. (#292)
        await abortableSleep(60_000 - elapsed, abortSignal);
      }
    }

    // ---- Get route ----
    let route: RouteResult;
    try {
      // When a handoff could fire this turn, pad the token estimate so the router's
      // context-window and TPM checks account for the extra system message overhead.
      const routingEstimate = handoffPossible ? estimatedTotal + HANDOFF_MAX_TOKENS : estimatedTotal;
      route = routeRequest(
        routingEstimate,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        hasImage,
        skipModels.size > 0 ? skipModels : undefined,
        { pinMode: isPinned, oneRPM: inOneRPMMode, stickySessionKey: sessionKey || undefined, triggeringClass, failedContextWindow, failedModelDbId, clientKeyId: auth.clientKey?.id ?? null, clientModelAllowlist: auth.clientKey?.modelAllowlist ?? null, reqTags },
      );
      attemptedModels.add(route.modelId);
      // F10: skip if circuit breaker is open for this (platform, model, keyId).
      if (isCircuitOpen(route.platform, route.modelId, route.keyId)) {
        route.release();
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        if (shouldMarkExhausted(route.platform, route.modelId, route.keyId)) {
          markExhausted(route.keyId, route.platform, route.modelId);
        }
        continue outerLoop;
      }

      // F4: check the $-budget for the authenticated client key.
      // Only enforced when a budget row exists for the scope — an empty
      // budgets table means no enforcement (today's behavior). The estimate
      // uses the selected model's pricing: actual_cost ?? paid ?? FALLBACK.
    } catch (err: any) {
      // Pinned model has no more keys — enter 1 RPM mode.
      if (err.code === 'PINNED_MODEL_EXHAUSTED') {
        const firstEntry = !inOneRPMMode;
        inOneRPMMode = true;
        oneRPMCycles++;
        skipKeys.clear();
        // 1-RPM throttle: on the first recovery entry, try immediately
        // (reset the clock). On subsequent entries, set lastRequestTime
        // to now so the 60 s loop-top throttle spaces recovery cycles
        // — otherwise routeRequest throw → 1 s sleep → retry loops at
        // full speed when no upstream call ever sets lastRequestTime.
        if (firstEntry) {
          lastRequestTime = 0;
          if (sawUpstream400 && upstreamAttempts > 0) {
            logger.warn('[Proxy] exhausted all routes with 400-class upstream failures — every model/key rejected this request; likely a client-side malformed request, not a provider outage', { id: requestId, attempts: upstreamAttempts, lastError: lastError ? String(lastError.message ?? '').slice(0, 200) : 'unknown' });
          }
        } else {
          // Enforce the throttle only when we actually called a provider
          // in the previous cycle — if routeRequest threw without any
          // upstream attempt (no keys configured, all keys dead), there's
          // nothing to rate-limit and the 60 s wait adds no value.
          if (upstreamAttempts > 0) lastRequestTime = Date.now();
          await abortableSleep(1000, abortSignal);
        }
        publish({ type: 'routing.recovery', id: requestId, cycle: oneRPMCycles, max: globalRetryMax > 0 ? globalRetryMax : null, reason: `Pinned model ${requestedModel} exhausted`, at: Date.now() });
        console.log(`[Proxy] Pinned model ${requestedModel} exhausted, entering 1 RPM recovery (cycle ${oneRPMCycles}${globalRetryMax > 0 ? '/' + globalRetryMax : '/∞'})`);
        continue;
      }
      // All models exhausted — enter 1 RPM mode.
      const firstEntry = !inOneRPMMode;
      inOneRPMMode = true;
      oneRPMCycles++;
      skipKeys.clear();
      if (firstEntry) {
        lastRequestTime = 0;
        if (sawUpstream400 && upstreamAttempts > 0) {
          logger.warn('[Proxy] exhausted all routes with 400-class upstream failures — every model/key rejected this request; likely a client-side malformed request, not a provider outage', { id: requestId, attempts: upstreamAttempts, lastError: lastError ? String(lastError.message ?? '').slice(0, 200) : 'unknown' });
        }
      } else {
        if (upstreamAttempts > 0) lastRequestTime = Date.now();
        await abortableSleep(1000, abortSignal);
      }
      publish({ type: 'routing.recovery', id: requestId, cycle: oneRPMCycles, max: globalRetryMax > 0 ? globalRetryMax : null, reason: 'All models exhausted', at: Date.now() });
        console.log(`[Proxy] All models exhausted, entering 1 RPM recovery (cycle ${oneRPMCycles}${globalRetryMax > 0 ? '/' + globalRetryMax : '/\u221E'})`);
        continue;
    }
    // Budget booking runs AFTER a successful acquisition: a throw anywhere in
    // here (DB error, corrupt pricing row) must release the provider slot and
    // the provisional reservations — otherwise the in-flight slot leaks for
    // the lifetime of the process. (H07)
    try {
      if (auth.clientKey) {
        // C02: a previous attempt's reservation may still be outstanding
        // (failover moved on without settling). Release it before reserving
        // for this attempt so failed attempts never accumulate phantom spend.
        if (budgetOpen) {
          releaseBudget('client_key', auth.clientKey.id, budgetEstCostCents);
          budgetOpen = false;
        }
        // M24: cached statement — this prepare fired on every routed request.
        budgetPricing = cachedPrepare(
          'SELECT actual_cost_input_per_m, actual_cost_output_per_m, paid_input_per_m, paid_output_per_m FROM models WHERE id = ?',
        ).get(route.modelDbId) as { actual_cost_input_per_m: number | null; actual_cost_output_per_m: number | null; paid_input_per_m: number | null; paid_output_per_m: number | null } | undefined;
        const estOutputTokens = max_tokens ?? route.maxOutputTokens ?? 1000;
        budgetEstCostCents = estimateCostCents(
          estimatedInputTokens, estOutputTokens,
          budgetPricing?.actual_cost_input_per_m ?? null, budgetPricing?.actual_cost_output_per_m ?? null,
          budgetPricing?.paid_input_per_m ?? null, budgetPricing?.paid_output_per_m ?? null,
        );
        const budgetResult = checkAndReserve('client_key', auth.clientKey.id, budgetEstCostCents);
        if (!budgetResult.allowed) {
          route.release();
          res.status(402).json({
            error: {
              type: 'budget_exhausted',
              message: `Budget exhausted (${budgetResult.exhaustedPeriod} limit reached)`,
              overage_cents: budgetResult.overageCents,
              scope: budgetResult.scope,
              period: budgetResult.exhaustedPeriod,
            },
          });
          return;
        }
        budgetOpen = true;
      }
    } catch (err) {
      route.release();
      if (budgetOpen) {
        releaseBudget('client_key', auth.clientKey!.id, budgetEstCostCents);
        budgetOpen = false;
      }
      throw err;
    }
    // The provider slot acquired by routeRequest above is released exactly
    // once per acquire, in the single finally at the end of this iteration —
    // held across same-key retries (`continue keyRetry`), released on every
    // exit (return, break keyRetry, continue outerLoop, or throw). (#9)
    try {
    const modelKey = `${route.platform}:${route.modelId}`;
    if (prevModelKey && prevModelKey !== modelKey && !isPinned) {
      publish({ type: 'routing.model_switch', id: requestId, from: prevModelKey, to: modelKey, reason: 'auto-routing fallback', at: Date.now() });
    } else if (prevKeyId !== undefined && prevKeyId !== route.keyId) {
      // Same model, different key — the proxy just rotated to a sibling key
      // because the previous one exhausted (or hit its pre-filter fallback).
      // Surfaces in the live terminal so the user can see "this request is
      // being retried on the next key" instead of inferring it from a gap
      // between two retry/exhaust events. (#256)
      publish({ type: 'routing.key_switch', id: requestId, provider: route.platform, model: route.modelId, fromKeyId: prevKeyId, toKeyId: route.keyId, at: Date.now() });
    }
    prevModelKey = modelKey;
    prevKeyId = route.keyId;
    let outboundMessages = messages;
    // Extra input tokens the injected handoff adds on this turn (0 when not
    // injected). Folded into the streaming success accounting, where token
    // counts are estimated; the non-stream path uses the provider's usage,
    // which already counts the injected message.
    let injectedHandoffTokens = 0;
    if (handoffMode !== 'off' && sessionKey) {
      // F1: context-handoff now runs through the HookPipeline so F7/F8 can
      // observe the mutation. The pipeline runs the registered pre-call hooks
      // in order (context-handoff is the only one today) and returns the
      // mutated messages + injection metadata.
      const handoff = pipeline.runPreCall({ mode: handoffMode, sessionKey, messages, selectedModelKey: modelKey });
      if (handoff.injected) console.log(`[Proxy] Context handoff injected (session ${sessionKey.slice(0, 8)}…, model switch detected)`);
      outboundMessages = handoff.messages;
      injectedHandoffTokens = handoff.injectedTokens;
    }
    // B2-6 O1: apply middle-layer outbound transform (redact → compress).
    // Memoized via middleSession so retries/fallbacks skip the interceptor
    // (Stage-2) and re-run only the cheap Stage-1 programmatic redaction.
    // The context-handoff summary (which contains prior user content) is
    // also covered because this runs AFTER the handoff injection.
    const middle = await applyOutbound(outboundMessages, middleSession);
    outboundMessages = middle.messages;
    if (middle.session) middleSession = middle.session;

    // Fallback for `max_tokens`: if the caller didn't supply a value
    // (some clients omit it entirely; OpenAI says "no limit" by default),
    // use the catalog's recorded max_output_tokens for the resolved model.
    // Some upstreams — notably NVIDIA NIM's minimax-m3 — return an empty
    // 200 (choices:[]) when max_tokens is absent, making the request
    // indistinguishable from "model just has nothing to say". Surfacing the
    // catalog cap as a default avoids that. The cap is nullable ("no known
    // bound"); normalize to undefined so CompletionOptions never carries an
    // explicit null down to providers.
    const catalogCap = route.maxOutputTokens ?? undefined;
    const effectiveMaxTokens = max_tokens ?? catalogCap;

    // MiniMax M2.x/M3 on openrouter / nvidia and similar aggregators returns reasoning
    // inline in `content` wrapped in `<think>` tags instead of using a separate
    // `reasoning_content` field. The api-gateway splits that into the
    // `reasoning_content` transport field so clients see a clean answer. The
    // gate shares the family detector with `buildModelCapabilities`
    // (deepseek-r1, kimi-k2-thinking, etc. match the same pattern; if any of
    // them ever emits the same tag the proxy handles it the same way).
    const isReasoningModel = isReasoningModelId(route.modelId);

    // ---- Per-key retry: up to PER_KEY_RETRIES immediate attempts ----
    let keySucceeded = false;
    keyRetry: for (let keyAttempt = 0; keyAttempt < PER_KEY_RETRIES; keyAttempt++) {
      try {
      // F9: acquire per-provider concurrency slot before the upstream call.
      let releaseSlot: (() => void) | null = null;
      if (isQueueEnabled()) {
        releaseSlot = await acquireSlot(route.platform);
      }
      try {
      if (stream) {
        // — Stream turn-integrity (#231 audit) —
        // The old loop forwarded upstream chunks verbatim and called any
        // stream that produced bytes a success. Live failure modes that
        // slipped through: in-band `{"error":...}` frames delivered as dead
        // turns, tool calls with no terminal finish_reason, inline tool-call
        // dialect emitted as text, truncations logged as success. This loop
        // validates the TURN, not the transport:
        //  - headers are held until the first real payload, so anything that
        //    dies before producing one fails over invisibly;
        //  - text that starts with an inline tool-call dialect marker is held
        //    and rescued into structured tool_calls (or failed over);
        //  - tool_call deltas are buffered, argument-repaired, and emitted as
        //    one complete chunk, always followed by finish_reason
        //    "tool_calls" — agents never see calls without a terminal reason;
        //  - a stream that ends with neither content nor calls is an empty
        //    completion and fails over like the non-stream path.
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;
        // L07: TTFB reference point — set when THIS attempt is dispatched to
        // the provider, not when the client request arrived. Measuring from
        // request start charged every fallback attempt for all prior attempts'
        // routing/retry wait, inflating the latency signal the bandit learns
        // from.
        let dispatchedAtMs = 0;

        // Hold-window state: 'undecided' until the first text either matches
        // a dialect marker (→ 'dialect': buffer everything, rescue at end) or
        // provably cannot (→ 'passthrough': flush and stream normally).
        let mode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';
        // `<think>` tag extraction state. Independent of the dialect detector:
        // both machines consume the same `text` chunk, the dialect
        // detector only ever sees visible text (post-extraction).
        const thinkStream = new ThinkTagStream();
        let bufferedReasoning = '';
        // B2-6 R2: streaming un-redactors. One for visible text, one for
        // reasoning — both share the same map but have independent buffers
        // so partial placeholder prefixes in one stream don't delay the
        // other. Null when no redaction session exists (redact was off).
        const visibleUnredactor = createStreamUnredactor(middleSession);
        const reasoningUnredactor = createStreamUnredactor(middleSession);
        const preamble: unknown[] = []; // role-only chunks held until flush
        const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
        let upstreamFinish: string | null = null;
        let usageChunk: unknown = null;
        let lastMeta: { id?: string; model?: string; created?: number } = {};

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - dispatchedAtMs;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          if (attemptedModels.size > 0) res.setHeader('X-Attempted-Models', [...attemptedModels].join(','));
          if (totalAttempt > 0) res.setHeader('X-Fallback-Attempts', String(totalAttempt));
          headerSent = true;
          for (const p of preamble) res.write(`data: ${JSON.stringify(p)}\n\n`);
          preamble.length = 0;
        };
        const mkChunk = (delta: Record<string, unknown>, finish: string | null) => ({
          id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: lastMeta.created ?? Math.floor(Date.now() / 1000),
          model: lastMeta.model ?? route.modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const writeChunk = (c: unknown) => res.write(`data: ${JSON.stringify(c)}\n\n`);
        // Force-off models reject thinking attempts outright (operator
        // switch, not a redirect); level subsets rewrite; rest pass. This is
        // a client-contract rejection — respond 400 immediately instead of
        // entering the failover loop below.
        const thinkingDecision = applyThinkingPolicy(route.thinkingPolicy, { reasoning_effort, thinking });
        if (!thinkingDecision.ok) {
          const msg = sanitizeProviderErrorMessage(thinkingDecision.error);
          logger.warn(`[Proxy] Rejected thinking attempt on force-disabled model`, { platform: route.platform, model: route.modelId });
          res.status(400).json({ error: { message: msg, type: 'invalid_request_error' } });
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, msg, null, pinnedModelId, false);
          return;
        }
        const thinkingRewrite = thinkingDecision.rewrite ?? { reasoning_effort, thinking };

        try {
          upstreamAttempts++; // counted toward the global recovery limit. (#292)
          dispatchedAtMs = Date.now();
          const gen = route.provider.streamChatCompletion(
            route.apiKey, outboundMessages, route.modelId,
            {
              temperature, max_tokens: effectiveMaxTokens, top_p, tools, tool_choice, parallel_tool_calls,
              ...thinkingRewrite,
              abortSignal,
            },
          );

          for await (const chunk of gen) {
            const anyChunk = chunk as Record<string, any>;

            // In-band upstream error frame (observed live: Groq emits
            // {"error":{...,"code":"tool_use_failed"}} inside a 200 SSE
            // stream). Before headers: retryable, the next model gets the
            // request. After: surface an error frame instead of pretending
            // the turn succeeded.
            if (anyChunk.error && !anyChunk.choices) {
              const msg = anyChunk.error.message ?? JSON.stringify(anyChunk.error).slice(0, 200);
              if (!headerSent) throw new Error(`in-band provider error from ${route.displayName}: ${msg}`);
              logger.error(`[Proxy] In-band error frame from ${route.displayName} mid-stream`, { provider: route.platform, model: route.modelId, keyId: route.keyId, message: String(msg) });
              writeChunk({ error: { message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(String(msg))}`, type: 'stream_error' } });
              try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
              recordRateLimitHit(route.modelDbId);
              logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, `in-band error frame: ${sanitizeProviderErrorMessage(String(msg))}`, ttfbMs, pinnedModelId, headerSent);
              return;
            }

            if (anyChunk.id) lastMeta = { id: anyChunk.id, model: anyChunk.model, created: anyChunk.created };

            const choice = anyChunk.choices?.[0];
            if (!choice) {
              // Usage-only frame (stream_options.include_usage) — held and
              // re-emitted after our finish chunk to preserve OpenAI ordering.
              if (anyChunk.usage) usageChunk = anyChunk;
              continue;
            }

            if (choice.finish_reason) upstreamFinish = choice.finish_reason;

            // Buffer tool_call deltas — emitted complete + repaired at end.
            for (const tc of choice.delta?.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: undefined, name: '', args: '' });
              const acc = toolCallAcc.get(idx)!;
              if (tc.id && !acc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }

            normalizeOutboundContent(chunk);
            let text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
            // Native reasoning_content: some models (DeepSeek v4 Pro, etc.) emit
            // reasoning in a dedicated delta key rather than in-band `<think>` tags.
            // Forward it as a reasoning_content chunk immediately so the client
            // sees the thinking stream, then check for visible content normally.
            const reasoningText = typeof choice.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content : '';
            if (reasoningText.length > 0) {
              flushHeaders();
              // B2-6 R2: un-redact native reasoning_content through the
              // streaming un-redactor (placeholders → real values).
              const safeReasoning = reasoningUnredactor ? reasoningUnredactor.feed(reasoningText) : reasoningText;
              if (safeReasoning.length > 0) writeChunk(mkChunk({ reasoning_content: safeReasoning }, null));
            }
            if (text.length === 0) {
              // Role preamble / keep-alive: hold until first payload decides
              // the mode, forward afterwards. tool_calls and finish_reason are
              // stripped — both are re-emitted complete at the end (OpenRouter
              // attaches tool_call deltas to chunks that also carry role/
              // reasoning keys; forwarding them raw would duplicate the call).
              //
              // MUST skip when we just forwarded native reasoning_content above
              // (reasoningText > 0): a reasoning-only chunk carries role +
              // reasoning_content, and re-emitting the raw delta here duplicates
              // every reasoning token — NVIDIA NIM repeats role:"assistant" on
              // every delta (whole thinking stream doubled), CommandCode only on
              // the first (first token doubled). The earlier key-check version
              // dropped `reasoning_content` from the .some() test but still
              // re-emitted the raw delta (which retained it) because `role` was
              // present. Visible content is unaffected — content chunks have
              // text.length > 0 and never reach this block.
              if (reasoningText.length === 0 && choice.delta && Object.keys(choice.delta).some(k => k !== 'content' && k !== 'tool_calls' && k !== 'reasoning_content' && choice.delta[k] != null)) {
                const cleaned = { ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined, reasoning_content: undefined }, finish_reason: null }] };
                if (headerSent) writeChunk(cleaned); else preamble.push(cleaned);
              }
              continue;
            }

            totalOutputTokens += Math.ceil(text.length / 4);

            if (mode === 'passthrough') {
              // Strip `<think>` tags from the chunk in-flight, emit any
              // extracted reasoning as a `reasoning_content` delta, and
              // forward the visible remainder. Reasoning arrives ahead of
              // the visible text it described — typical for a long-form
              // think block that closes before the answer begins.
              if (isReasoningModel) {
                const think = thinkStream.feed(text);
                // B2-6 R2: un-redact visible and reasoning through separate
                // streaming un-redactors (independent buffers).
                const safeReasoning = reasoningUnredactor ? reasoningUnredactor.feed(think.reasoning) : think.reasoning;
                if (safeReasoning.length > 0) {
                  writeChunk(mkChunk({ reasoning_content: safeReasoning }, null));
                }
                text = visibleUnredactor ? visibleUnredactor.feed(think.visible) : think.visible;
                if (text.length === 0) continue;
              }
              // B2-6 R2: un-redact visible content for non-reasoning models
              // (reasoning models already un-redacted inside the block above).
              if (!isReasoningModel) {
                text = visibleUnredactor ? visibleUnredactor.feed(text) : text;
                if (text.length === 0) continue;
              }
              // reasoning_content is stripped here: any reasoning on this
              // chunk was already forwarded by the native reasoning_content
              // block above, so leaving it in the spread would re-emit it if
              // a provider ever packs content and reasoning_content into the
              // same delta.
              writeChunk({ ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, content: text, tool_calls: undefined, reasoning_content: undefined }, finish_reason: null }] });
              continue;
            }

            // mode is 'undecided' or 'dialect'. Route the chunk through the
            // think extractor first so the dialect detector only ever sees
            // visible text. Pure-reasoning chunks (visible==='') bypass
            // the dialect detector entirely — nothing to feed.
            if (isReasoningModel) {
              const think = thinkStream.feed(text);
              // B2-6 R2: un-redact visible and reasoning (undecided/dialect).
              const safeReasoning = reasoningUnredactor ? reasoningUnredactor.feed(think.reasoning) : think.reasoning;
              if (safeReasoning.length > 0) {
                bufferedReasoning += safeReasoning;
              }
              text = visibleUnredactor ? visibleUnredactor.feed(think.visible) : think.visible;
              if (text.length === 0) continue;
            }
            // B2-6 R2: un-redact visible content for non-reasoning models.
            if (!isReasoningModel) {
              text = visibleUnredactor ? visibleUnredactor.feed(text) : text;
              if (text.length === 0) continue;
            }
            heldText += text;
            if (mode === 'dialect') continue;

            const probe = heldText.trimStart();
            if (startsWithDialectMarker(probe)) {
              mode = 'dialect';
            } else if (!couldBecomeDialectMarker(probe) || probe.length > 256) {
              mode = 'passthrough';
              flushHeaders();
              if (bufferedReasoning.length > 0) {
                writeChunk(mkChunk({ reasoning_content: bufferedReasoning }, null));
                bufferedReasoning = '';
              }
              writeChunk(mkChunk({ content: heldText }, null));
              heldText = '';
            }
            // else: still a strict prefix of a marker — keep holding.
          }

          // — Stream ended cleanly (provider saw [DONE] or a finish_reason) —

          // Assemble buffered tool calls: synthesize missing ids, repair
          // double-encoded arguments against the request's schemas, drop
          // calls whose args still aren't valid JSON.
          const schemas = toolSchemaMap(tools);
          let syntheticStreamIds = 0;
          const completedCalls = [...toolCallAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, acc]) => ({
              id: acc.id && acc.id.length > 0 ? acc.id : `call_stream_${++syntheticStreamIds}`,
              type: 'function' as const,
              function: { name: acc.name, arguments: repairToolArguments(middleSession ? unredactResponseText(acc.args || '{}', middleSession) : (acc.args || '{}'), schemas.get(acc.name)) },
            }))
            .filter(c => { try { JSON.parse(c.function.arguments); return c.function.name.length > 0; } catch { return false; } });

          // Dialect rescue: the held text is an inline tool call in some
          // model's private syntax. Parse it into structured calls or treat
          // the turn as dead (headers were never sent in dialect mode, so
          // failing over is free).
          if (mode === 'dialect' || (mode === 'undecided' && heldText.length > 0 && containsDialectMarker(heldText))) {
            const rescue = rescueInlineToolCalls(heldText, new Set((tools ?? []).map(t => t.function.name)));
            if (rescue.detected) {
              if (!rescue.calls) throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${heldText.slice(0, 120)}`);
              let rescuedIds = 0;
              for (const c of rescue.calls) {
                completedCalls.push({ id: `call_rescued_${++rescuedIds}`, type: 'function', function: { name: c.name, arguments: repairToolArguments(middleSession ? unredactResponseText(c.arguments, middleSession) : c.arguments, schemas.get(c.name)) } });
              }
              heldText = rescue.cleanText;
              console.log(`[Proxy] Rescued ${rescuedIds} inline tool call(s) from ${route.displayName} into structured tool_calls`);
            }
          }
          // Flush the think stream. Residual (unclosed-opener tail) is
          // appended to visible text — safe default, per the
          // think-tags.ts comment. Any reasoning the stream still held
          // (rare; complete blocks emit on the closing feed) is folded
          // into the buffered reasoning emitted below.
          const thinkFinal = thinkStream.flush();
          if (thinkFinal.reasoning.length > 0) {
            bufferedReasoning += thinkFinal.reasoning;
          }
          if (thinkFinal.residual.length > 0) {
            heldText += thinkFinal.residual;
          }
          // B2-6 R2: flush the streaming un-redactors — emit any held-back
          // residual that was a potential partial-placeholder prefix.
          const visibleResidual = visibleUnredactor ? visibleUnredactor.flush() : '';
          const reasoningResidual = reasoningUnredactor ? reasoningUnredactor.flush() : '';
          if (visibleResidual.length > 0) heldText += visibleResidual;
          if (reasoningResidual.length > 0) bufferedReasoning += reasoningResidual;

          const hasText = headerSent || heldText.trim().length > 0 || bufferedReasoning.length > 0;
          if (!hasText && completedCalls.length === 0) {
            // Nothing usable came out — same failover semantics as the
            // non-stream empty-completion path. Headers can't have been sent
            // (header flush requires payload), so the client never notices.
            throw new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`);
          }

          flushHeaders();
          if (bufferedReasoning.length > 0) {
            writeChunk(mkChunk({ reasoning_content: bufferedReasoning }, null));
          }
          if (heldText.length > 0) {
            writeChunk(mkChunk({ content: heldText }, null));
          }
          if (completedCalls.length > 0) {
            writeChunk(mkChunk({ tool_calls: completedCalls.map((c, i) => ({ index: i, ...c })) }, null));
            totalOutputTokens += Math.ceil(completedCalls.reduce((n, c) => n + c.function.arguments.length, 0) / 4);
          }
          // Terminal finish_reason, ALWAYS present: calls win over a sloppy
          // upstream 'stop'; 'length'/'content_filter' survive for pure-text
          // turns; missing upstream reason is synthesized.
          const finish = completedCalls.length > 0
            ? 'tool_calls'
            : (upstreamFinish && upstreamFinish !== 'tool_calls' ? upstreamFinish : 'stop');
          writeChunk(mkChunk({}, finish));
          if (usageChunk) writeChunk(usageChunk);
          res.write('data: [DONE]\n\n');
          res.end();

          recordRequest(route.platform, route.modelId, route.keyId);
          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + injectedHandoffTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(token, messages, route.modelDbId, sessionIdHeader);
          if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens + injectedHandoffTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId, headerSent);
          publish({ type: 'request.done', id: requestId, model: route.modelId, provider: route.platform, keyId: route.keyId, latencyMs: Date.now() - start, tokens: { in: estimatedInputTokens + injectedHandoffTokens, out: totalOutputTokens }, at: Date.now() });
          clearExhausted(route.keyId, route.modelId);
          recordCircuitSuccess(route.platform, route.modelId, route.keyId);
          if (inOneRPMMode) { inOneRPMMode = false; oneRPMCycles = 0; }
          // F4: reconcile the budget estimate with actual token usage.
          if (auth.clientKey && budgetEstCostCents > 0) {
            const actualCostCents = estimateCostCents(
              estimatedInputTokens + injectedHandoffTokens, totalOutputTokens,
              budgetPricing?.actual_cost_input_per_m ?? null, budgetPricing?.actual_cost_output_per_m ?? null,
              budgetPricing?.paid_input_per_m ?? null, budgetPricing?.paid_output_per_m ?? null,
            );
            recordSpend('client_key', auth.clientKey.id, actualCostCents, budgetEstCostCents);
          }
          budgetOpen = false;
          return;
        } catch (streamErr: any) {
          if (isAbortError(streamErr) || abortSignal.aborted) throw streamErr;
          if (headerSent) {
            // Mid-stream error after real payload reached the client — finish
            // the SSE response honestly instead of leaving the client hanging.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), null, pinnedModelId, headerSent);
            recordRateLimitHit(route.modelDbId);
            return;
          }
          // Headers never sent — bubble to the outer retry handler, which
          // cooldowns this model+key and tries the next one. Covers upstream
          // HTTP errors, in-band error frames, abrupt EOF, stalls, empty
          throw streamErr;
        }
      } else {
        // Same force-off rejection as the streaming path above.
        const thinkingDecision = applyThinkingPolicy(route.thinkingPolicy, { reasoning_effort, thinking });
        if (!thinkingDecision.ok) {
          const msg = sanitizeProviderErrorMessage(thinkingDecision.error);
          logger.warn(`[Proxy] Rejected thinking attempt on force-disabled model`, { platform: route.platform, model: route.modelId });
          res.status(400).json({ error: { message: msg, type: 'invalid_request_error' } });
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, msg, null, pinnedModelId, false);
          return;
        }
        const thinkingRewrite = thinkingDecision.rewrite ?? { reasoning_effort, thinking };
        upstreamAttempts++; // counted toward the global recovery limit. (#292)
        const result = await route.provider.chatCompletion(
          route.apiKey, outboundMessages, route.modelId,
          {
            temperature, max_tokens: effectiveMaxTokens, top_p, tools, tool_choice, parallel_tool_calls,
            ...thinkingRewrite,
            abortSignal,
          },
        );
        // Empty completion (no text, no tool calls) → fail over rather than
        // return a transport-level "success" the caller can't act on. Mirrors
        // the zero-chunk streaming case above.
        const respMsg = result.choices?.[0]?.message;
        const respText = contentToString(respMsg?.content ?? '');
        if (!respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          throw new Error(`empty completion from ${route.displayName}`);
        }

        // F1: post-call transforms (tool-rescue + think-tags) now run through
        // the HookPipeline so F7/F8 can observe the mutations. The pipeline
        // runs tool-rescue FIRST (so think-tags only sees visible text), then
        // think-tags, threading the mutated content through both. The proxy
        // applies the pipeline's result to respMsg here — the hooks themselves
        // never touch the response object, keeping them pure-ish.
        if (respMsg) {
          const postResult = pipeline.runPostCallSuccess({
            content: respText,
            reasoning: respMsg.reasoning_content ?? '',
            toolNames: new Set((tools ?? []).map(t => t.function.name)),
            isReasoningModel,
            wantsTools: (tools?.length ?? 0) > 0,
            hasExistingToolCalls: (respMsg.tool_calls?.length ?? 0) > 0,
          });
          // Apply tool-rescue result (structured tool_calls).
          if (postResult.toolCallsDetected && postResult.toolCalls) {
            const schemas = toolSchemaMap(tools);
            respMsg.tool_calls = postResult.toolCalls.map((c, i) => ({
              id: `call_rescued_${i + 1}`,
              type: 'function' as const,
              function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) },
            }));
            respMsg.content = postResult.content.length > 0 ? postResult.content : null;
            if (result.choices?.[0]) result.choices[0].finish_reason = 'tool_calls';
            console.log(`[Proxy] Rescued ${postResult.toolCalls.length} inline tool call(s) from ${route.displayName} into structured tool_calls`);
          } else if (postResult.content !== respText) {
            // Think-tags modified the content (or tool-rescue cleanText).
            respMsg.content = postResult.content.length > 0 ? postResult.content : null;
          }
          // Apply reasoning (only if think-tags extracted reasoning).
          if (postResult.reasoning && postResult.reasoning !== (respMsg.reasoning_content ?? '')) {
            respMsg.reasoning_content = postResult.reasoning;
          }
        }

        const estCompletionTokens = respMsg
          ? Math.ceil((respText.length + (respMsg.tool_calls ?? []).reduce((n, tc) => n + tc.function.arguments.length, 0)) / 4)
          : 0;
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? estCompletionTokens;
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(token, messages, route.modelDbId, sessionIdHeader);
        if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attemptedModels.size > 0) res.setHeader('X-Attempted-Models', [...attemptedModels].join(','));
        if (totalAttempt > 0) res.setHeader('X-Fallback-Attempts', String(totalAttempt));
        if (inOneRPMMode) res.setHeader('X-Recovery-Mode', '1rpm');
        // Repair double-encoded tool arguments against the request's tool
        // schemas (e.g. GLM emitting an array parameter as a JSON string),
        // so strict clients don't reject the call. Schema-gated — a true
        // string parameter is never touched. See lib/tool-args.ts.
        if (respMsg?.tool_calls?.length) {
          const schemas = toolSchemaMap(tools);
          for (const tc of respMsg.tool_calls) {
            if (tc?.function?.arguments != null) {
              tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
            }
          }
        }
        // B2-6 R1: un-redact the non-streaming response (placeholders →
        // real values). Runs AFTER post-call transforms and tool-arg repair
        // so those see the placeholder text the model produced. Then run
        // the inbound interceptor (non-streaming only, per D2) to catch
        // new secrets the model emitted.
        if (middleSession && respMsg) {
          if (typeof respMsg.content === 'string') {
            respMsg.content = unredactResponseText(respMsg.content, middleSession);
          }
          if (typeof respMsg.reasoning_content === 'string') {
            respMsg.reasoning_content = unredactResponseText(respMsg.reasoning_content, middleSession);
          }
          if (respMsg.tool_calls?.length) {
            for (const tc of respMsg.tool_calls) {
              if (tc?.function?.arguments) {
                tc.function.arguments = unredactResponseText(tc.function.arguments, middleSession);
              }
            }
          }
          // B2-4b: inbound interceptor — scan for new secrets the model
          // emitted (non-streaming only). Re-redacts ONLY new secrets so
          // outbound secrets reach the client as real values.
          if (typeof respMsg.content === 'string' && respMsg.content.length > 0) {
            const inbound = await interceptInboundText(respMsg.content, middleSession);
            if (inbound.newSecretsFound) respMsg.content = inbound.text;
          }
        }
        // Normalize array-shaped message.content to a string on the way out
        // (#166). L18: compute ONCE — the result feeds both the client
        // response and the cache write below (the normalizer mutates in place,
        // so re-running it per consumer was pure duplicate work).
        const outboundResult = normalizeOutboundContent(result);
        res.json(outboundResult);

        logRequest(
          route.platform, route.modelId, route.keyId, 'success',
          promptTokens,
          completionTokens,
          Date.now() - start, null, null, pinnedModelId,
        );
        publish({ type: 'request.done', id: requestId, model: route.modelId, provider: route.platform, keyId: route.keyId, latencyMs: Date.now() - start, tokens: { in: promptTokens, out: completionTokens }, at: Date.now() });
        clearExhausted(route.keyId, route.modelId);
        recordCircuitSuccess(route.platform, route.modelId, route.keyId);
        if (inOneRPMMode) { inOneRPMMode = false; oneRPMCycles = 0; }
        // F4: reconcile the budget estimate with actual token usage.
        if (auth.clientKey && budgetEstCostCents > 0) {
          const actualCostCents = estimateCostCents(
            promptTokens, completionTokens,
            budgetPricing?.actual_cost_input_per_m ?? null, budgetPricing?.actual_cost_output_per_m ?? null,
            budgetPricing?.paid_input_per_m ?? null, budgetPricing?.paid_output_per_m ?? null,
          );
          recordSpend('client_key', auth.clientKey.id, actualCostCents, budgetEstCostCents);
        }
        budgetOpen = false;
        // F5: store the response in the cache (only temp-0, non-streaming).
        if (cacheKey && !stream) {
          setCachedResponse(cacheKey, JSON.stringify(outboundResult));
        }
        return;
      }
      } finally {
        // F9: release the per-provider concurrency slot.
        if (releaseSlot) releaseSlot();
      }
    } catch (err: any) {
      // F9: queue full or timeout — return 503 with Retry-After (D-FEATURES-6).
      if (err instanceof QueueTimeoutError) {
        const retryAfterSec = Math.ceil(err.timeoutMs / 1000);
        if (!res.headersSent) {
          setRetryAfter(res, retryAfterSec);
          res.status(503).json({
            error: {
              type: 'queue_full',
              message: err.message,
              queue_timeout_ms: err.timeoutMs,
              platform: err.platform,
            },
          });
        }
        publish({ type: 'request.error', id: requestId, error: `Queue ${err.reason}: ${err.message}`, at: Date.now() });
        return;
      }
      // Client stopped the request (Stop button / closed session). This is NOT
      // a provider failure — don't log an error, don't retry, don't 502. Just
      // end the response silently. The abort signal already cancelled the
      // in-flight upstream fetch; here we unwind the loop. (#292)
      if (isAbortError(err) || abortSignal.aborted) {
        if (!res.writableEnded) {
          try { res.end(); } catch { /* socket already gone */ }
        }
        publish({ type: 'request.aborted', id: requestId, at: Date.now() });
        return;
      }
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId);


      if (isRetryableError(err)) {
        // Dead-turn errors (in-band error, empty completion, stream stall,
        // unparseable dialect): in-band error means the key WORKS but this
        // specific model can't handle the request. Skip the model, not the
        // key — retrying a different model on the same key is valid.
        //
        // NOTE: `api error 400` is deliberately NOT in this list. A 400 can be
        // a KEY-level failure (CommandCode returns 400/403 for quota/auth/key
        // issues, not just bad params), and skipping the model immediately
        // never rotates the key — so a request with one exhausted key and one
        // healthy key would hammer the dead key forever (issue #293: only
        // key#85 was ever tried, key#86 never got a chance). A 400 now falls
        // through to the normal per-key retry → markExhausted → router rotates
        // to the next key, which tries the SAME model on the healthy key. A
        // genuine model-level 400 still converges: once every key 400s on it,
        // the model is effectively ruled out by exhaustion.
        const msg = (err.message ?? '').toLowerCase();
        const skipImmediately = msg.includes('in-band provider error')
          || msg.includes('empty completion')
          || msg.includes('stream ended unexpectedly')
          || msg.includes('stream stalled')
          || msg.includes('unparseable inline tool-call dialect');

        if (skipImmediately) {
          if (isPinned && route.modelDbId === preferredModel) {
            // Pinned + dead-turn (in-band error / empty completion / stall /
            // unparseable dialect): the model ITSELF can't handle this request
            // — a different key on the same model will get the same verdict, so
            // retrying across all keys (3 keys × 3 retries = 9 upstream calls)
            // then entering 1-RPM recovery and looping is pure waste. Fall
            // through to a sibling model is forbidden by the pin. Surface the
            // model's error to the user as 502 so they can adjust the request
            // or unpin — same shape as the non-retryable path below. Observed
            // live (#295): NVIDIA NIM returns an in-band `Internal server error`
            // frame for glm-5.2 on ~100k-token inputs while minimax-m3 on the
            // SAME key succeeds — a model-specific large-prefill failure that
            // the gateway must not pretend is a transient retryable condition.
            const errorMsg = `Provider error (${route.displayName}): ${safeError}`;
            publish({ type: 'request.error', id: requestId, error: errorMsg, at: Date.now() });
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attemptedModels.size > 0) res.setHeader('X-Attempted-Models', [...attemptedModels].join(','));
            if (totalAttempt > 0) res.setHeader('X-Fallback-Attempts', String(totalAttempt));
            res.status(502).json({ error: { message: errorMsg, type: 'provider_error' } });
            return;
          }
          // Non-pinned dead-turn: skip this model, try the next one in the
          // chain (the key works — a different model on it may succeed).
          setCooldown(route.platform, route.modelId, route.keyId, computeRetryCooldownMs(false), 'dead_turn');
          recordRateLimitHit(route.modelDbId);
          skipModels.add(route.modelDbId);
          continue outerLoop;
        }

        if (keyAttempt < PER_KEY_RETRIES - 1) {
          // Genuine upstream rate-limit 429: don't retry same key immediately.
          // The old behavior fired 3 real upstream calls (PER_KEY_RETRIES) in
          // <1.5s on the SAME key with zero backoff — and that burst burns the
          // real per-minute account budget NVIDIA NIM enforces across ALL its
          // models under one key (40 RPM). One failing request then self-DoS'd
          // 3 keys × 3 retries = 9 real upstream 429 calls in <1.5s, exhausting
          // the shared bucket for the whole account and every sibling model.
          // Now: back off before the retry — a short escalating sleep (1s,
          // 2s) only; upstream Retry-After headers are deliberately NOT
          // parsed (F13 stance). The abortableSleep yields on client
          // disconnect so a dead request stops consuming budget. Transient
          // transport errors (timeout, econnreset, 5xx) keep the immediate
          // retry — they don't draw on a shared per-minute quota, so backoff
          // only helps the genuine 429 path.
          const is429 = isRateLimitError(err);
          if (is429) {
            const sleepMs = 1000 * (keyAttempt + 1); // 1s then 2s
            logger.info(`[Proxy] rate-limited — backing off ${sleepMs}ms then retry ${keyAttempt + 1}/${PER_KEY_RETRIES} (same key)`, { provider: route.platform, model: route.modelId, keyId: route.keyId, sleepMs, attempt: keyAttempt + 1, max: PER_KEY_RETRIES, message: safeError.slice(0, 300) });
            await abortableSleep(sleepMs, abortSignal);
          } else {
            publish({ type: 'routing.key_retry', id: requestId, provider: route.platform, keyId: route.keyId, model: route.modelId, attempt: keyAttempt + 1, max: PER_KEY_RETRIES, at: Date.now() });
            logger.info(`[Proxy] retry ${keyAttempt + 1}/${PER_KEY_RETRIES} (same key)`, { provider: route.platform, model: route.modelId, keyId: route.keyId, attempt: keyAttempt + 1, max: PER_KEY_RETRIES, message: safeError.slice(0, 300) });
          }
          if (err?.status === 400 || (err?.message ?? '').includes('api error 400')) sawUpstream400 = true;
          lastError = err;
          continue keyRetry;
        }
        // Last retry attempt exhausted → fall through to key exhaustion.
        if (err?.status === 400 || (err?.message ?? '').includes('api error 400')) sawUpstream400 = true;
        lastError = err;
        break keyRetry;
      } else {
        // Non-retryable error (auth, 4xx, etc.): don't retry.
        const errorMsg = `Provider error (${route.displayName}): ${safeError}`;
        publish({ type: 'request.error', id: requestId, error: errorMsg, at: Date.now() });
        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attemptedModels.size > 0) res.setHeader('X-Attempted-Models', [...attemptedModels].join(','));
        if (totalAttempt > 0) res.setHeader('X-Fallback-Attempts', String(totalAttempt));
        res.status(502).json({
          error: {
            message: errorMsg,
            type: 'provider_error',
          },
        });
        return;
      }
    }
    } // end keyRetry

    // Key exhausted: all PER_KEY_RETRIES attempts failed.
    // Mark it so the router cycles to the next key (and in 1 RPM mode,
    // exhausted keys are re-tried in exhaustion order).
    // F10: record circuit breaker failure for this (platform, model, keyId).
    recordCircuitFailure(route.platform, route.modelId, route.keyId);

    markExhausted(route.keyId, route.platform, route.modelId);
    const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
    skipKeys.add(skipId);
    setCooldown(
      route.platform,
      route.modelId,
      route.keyId,
      computeRetryCooldownMs(
        isPaymentRequiredError(lastError),
      ),
      classifyCooldownReason(lastError).reason,
      classifyCooldownReason(lastError).statusCode,
    );
    recordRateLimitHit(route.modelDbId);
    lastRequestTime = Date.now();
    publish({ type: 'routing.key_exhausted', id: requestId, provider: route.platform, keyId: route.keyId, model: route.modelId, reason: sanitizeProviderErrorMessage(lastError?.message), at: Date.now() });
    console.log(`[Proxy] Key ${route.keyId} exhausted after ${PER_KEY_RETRIES} failures from ${route.displayName}`);

    // F2 (β): classify the error for the next routeRequest call so the
    // router skips models that would fail the same way.
    triggeringClass = classifyError(lastError);
    failedContextWindow = route.contextWindow;
    failedModelDbId = route.modelDbId;
    // Continue outer loop → routeRequest picks next key.
    } finally {
      route.release();
    }
  }
  } catch (err: any) {
    // A RequestAbortError from an abortableSleep at the outer-loop level
    // (the 60s 1-RPM throttle or the 1s recovery pauses) propagates here on
    // client disconnect. End the response silently — no error log, no retry,
    // no 502. The abort signal already cancelled any in-flight upstream call.
    // (#292)
    if (isAbortError(err) || abortSignal.aborted) {
      if (!res.writableEnded) {
        try { res.end(); } catch { /* socket already gone */ }
      }
      publish({ type: 'request.aborted', id: requestId, at: Date.now() });
      return;
    }
    // Any other unexpected error: surface as a 502 if nothing was sent yet.
    console.error('[Proxy] Unhandled error in retry loop:', err);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Internal error: ${sanitizeProviderErrorMessage(err?.message)}`, type: 'provider_error' } });
    }
  } finally {
    // C02: safety net — any exit that didn't settle the budget (abort,
    // mid-stream error, failover exhaustion, unexpected throw) releases the
    // outstanding reservation instead of leaving phantom spend behind.
    if (budgetOpen && auth.clientKey) {
      releaseBudget('client_key', auth.clientKey.id, budgetEstCostCents);
    }
    detachAbortWatcher();
  }

  // Unreachable — the outer loop exits via the 1-RPM limit check above.
});

export function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
  // The model id the client pinned; null for auto-routed requests. Lets
  // analytics split pinned vs auto traffic and detect failover overrides
  // (requested_model set but != model_id).
  requestedModel: string | null = null,
  // L07: whether an SSE (text/event-stream) response was actually sent to the
  // client. The old inference (`outputTokens > 0 && ttfbMs !== null`) labeled
  // a 0-token stream as non-stream; callers now report what was really sent.
  streamed: boolean = false,
) {
  try {
    const db = getDb();
    // C2: compute per-token latency (null when no output tokens, e.g. errors).
    const latencyPerTokenMs = outputTokens > 0 ? latencyMs / outputTokens : null;
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, latency_per_token_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel, latencyPerTokenMs);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
  // F7: record Prometheus metrics alongside the DB log.
  try {
    recordMetricsRequest({
      platform, model: modelId,
      status: status === 'success' ? 'success' : 'error',
      stream: streamed,
      latencyMs,
    });
    if (inputTokens > 0 || outputTokens > 0) {
      recordMetricsTokens({ platform, model: modelId, inputTokens, outputTokens });
    }
  } catch { /* metrics are best-effort */ }
}
