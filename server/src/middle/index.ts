/**
 * Middle-layer orchestrator — Row B2-6.
 *
 * Single entry point for both /v1/chat/completions and /v1/responses to apply
 * the outbound transform pipeline (Stage-1 programmatic redact → Stage-2 AI
 * interceptor → compress).  Enforces the redact→compress ordering from
 * PRIVACY-LAYER-FABLE §0 invariant #2.
 *
 * When both toggles are off, `applyOutbound` is a no-op (never called — the
 * call sites guard inline, same pattern as `handoffMode !== 'off'`).  When
 * redaction is off but compression is on (B1, not yet wired), the redaction
 * step is skipped.
 *
 * Retry semantics (§1.4): the interceptor (Stage-2) runs ONCE per request
 * (first attempt).  On subsequent attempts the session is reused and only
 * Stage-1 (cheap, deterministic string matching) is re-run — the
 * context-handoff message varies per routed model so Stage-1 must re-run, but
 * the interceptor never re-runs.
 */
import type { ChatMessage } from '@api-gateway/shared';
import { getSetting } from '../db/index.js';
import { RedactionSession } from './redaction/session.js';
import { getActiveSecretsForRedaction } from './redaction/store.js';
import { interceptOutbound, interceptInbound } from './redaction/interceptor.js';
import { StreamUnredactor } from './redaction/stream-unredact.js';
import { getCompressionConfig } from './compression/index.js';
import { smartCrush } from './compression/techniques/smart-crusher.js';
// ── Per-request session ────────────────────────────────────────────────────

export interface MiddleSession {
  redaction: RedactionSession;
  /** True after the Stage-2 AI interceptor has run at least once.  Gates
   * subsequent attempts to skip the interceptor and re-run Stage-1 only. */
  interceptorRan: boolean;
}

export interface ApplyOutboundResult {
  messages: ChatMessage[];
  session?: MiddleSession;
}

// ── Config with TTL cache (§1.3) ───────────────────────────────────────────

export interface MiddleConfig {
  redactionEnabled: boolean;
  compressionEnabled: boolean;
}

let configCache: { value: MiddleConfig; expires: number } | null = null;
const CONFIG_TTL_MS = 5000;

export function getMiddleConfig(): MiddleConfig {
  if (configCache && Date.now() < configCache.expires) {
    return configCache.value;
  }
  const redactionEnabled = getSetting('middle_redaction_enabled') === '1';
  const compressionEnabled = getSetting('middle_compression_enabled') === '1';
  configCache = {
    value: { redactionEnabled, compressionEnabled },
    expires: Date.now() + CONFIG_TTL_MS,
  };
  return configCache.value;
}

/** Clear the config cache — used by tests and settings changes. */
export function clearMiddleConfigCache(): void {
  configCache = null;
}

// ── Redaction instruction (injected after redaction, before compression) ────

const REDACTION_INSTRUCTION = [
  "This conversation contains placeholder tokens in the format ⟦R{n}:{hexTag}⟧ — for example ⟦R1:a3b724⟧, ⟦R1:f00d12⟧. (The leading number is a store generation; all current tokens use generation 1.)",
  "These placeholders indicate that sensitive values (API keys, emails, passwords, personal data) have been programmatically redacted before reaching you.",
  "They are NOT corrupted, truncated, or wrong data. They are intentional redaction markers.",
  "",
  "Rules:",
  "1. NEVER acknowledge or mention the redaction in your response. Do NOT say things like 'this appears to be corrupted', 'there was sensitive data removed here', or 'the key appears to be redacted'.",
  "2. NEVER try to redact further or add your own redaction disclaimers — the privacy layer already handled it.",
  "3. Treat every ⟦R⟧ placeholder exactly as if it were the original value. Process the content normally.",
  "4. When your answer needs a value that appears here only as an ⟦R⟧ placeholder, echo the placeholder EXACTLY as-is (same number and hex tag) — never paraphrase, truncate, or invent a replacement value.",
  "5. The gateway transparently substitutes your echoed placeholders with the original values before the client sees the response, so the user always sees their real data. A placeholder you alter cannot be rehydrated and would reach the client as literal text.",
].join('\n');

/** Append the redaction instruction as a system message, after the last system message. */
function injectRedactionInstruction(messages: ChatMessage[]): ChatMessage[] {
  let lastSystemIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') { lastSystemIdx = i; break; }
  }
  const instruction: ChatMessage = { role: 'system', content: REDACTION_INSTRUCTION };
  if (lastSystemIdx >= 0) {
    return [...messages.slice(0, lastSystemIdx + 1), instruction, ...messages.slice(lastSystemIdx + 1)];
  }
  return [instruction, ...messages];
}

// ── Outbound pipeline ──────────────────────────────────────────────────────

/**
 * Apply the outbound middle-layer transform to the message array.
 *
 * Call sites (O1: proxy.ts after context-handoff, O2: responses.ts after
 * toChatMessages) pass the current `session` (from a handler-local `let`)
 * so retries reuse the same redaction session and skip the interceptor.
 *
 * Returns a NEW message array (non-mutating, same convention as the handoff).
 * When neither toggle is enabled, returns the original array with no session.
 */
export async function applyOutbound(
  messages: ChatMessage[],
  session?: MiddleSession,
): Promise<ApplyOutboundResult> {
  const cfg = getMiddleConfig();
  if (!cfg.redactionEnabled && !cfg.compressionEnabled) {
    return { messages };
  }

  let workingMessages = messages;
  let resultSession = session;

  // ── Stage 1+2: Redaction (redact → AI intercept) ────────────────────────
  if (cfg.redactionEnabled) {
    // Existing session (retry/fallback) → Stage-1 only, reuse the session.
    if (session?.redaction) {
      workingMessages = session.redaction.redactOutbound(messages);
    } else {
      // First attempt → Stage-1 programmatic + Stage-2 AI interceptor.
      const secrets = getActiveSecretsForRedaction();
      const redactionSession = new RedactionSession(secrets);
      workingMessages = redactionSession.redactOutbound(messages);
      const intercepted = await interceptOutbound(workingMessages, redactionSession);
      workingMessages = intercepted.messages;
      resultSession = {
        redaction: redactionSession,
        interceptorRan: true,
      };
    }
  }

  // N28: when this request actually redacted anything, prepend the
  // instruction above so the model treats ⟦R{n}:{hexTag}⟧ markers as
  // intentional placeholders (and echoes them verbatim for rehydration)
  // instead of reading them as corrupted data.
  if (cfg.redactionEnabled && resultSession?.redaction?.hasRedactions()) {
    workingMessages = injectRedactionInstruction(workingMessages);
  }

  // ── Stage 3: Compression (runs AFTER redact per §0 invariant #2) ──────────
  if (cfg.compressionEnabled) {
    workingMessages = compressToolMessages(workingMessages);
  }

  return { messages: workingMessages, session: resultSession };
}

/**
 * Compress role:"tool" JSON-array messages using SmartCrusher.
 * Appends the drop sentinel to the compressed tool output itself (M46 —
 * never a system message interleaved after tool messages).
 * Non-mutating — returns a new array. Skips the last `protectRecent` messages.
 */
function compressToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const compCfg = getCompressionConfig();
  if (!compCfg.enabled || !compCfg.smartCrusher) return messages;

  const protectRecent = compCfg.protectRecent;
  const skipCount = Math.min(protectRecent, messages.length);
  const cutoff = messages.length - skipCount;

  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Skip messages in the protect_recent window
    if (i >= cutoff) {
      result.push(msg);
      continue;
    }
    // Only compress role:"tool" with string content
    if (msg.role !== 'tool' || typeof msg.content !== 'string') {
      result.push(msg);
      continue;
    }
    // Try SmartCrusher
    const crushResult = smartCrush(msg.content, {
      losslessOnly: compCfg.smartCrusherLosslessOnly,
      emitSentinel: compCfg.emitSentinel,
      minSavingsRatio: compCfg.minSavingsRatio,
    });
    if (!crushResult.applied) {
      result.push(msg);
      continue;
    }
    // Replace content with compressed form. M46: the sentinel is appended
    // to the SAME tool message, never injected as a `system` message after
    // a tool message — strict OpenAI-compat providers reject or mis-handle
    // system-after-tool interleaving.
    result.push({
      ...msg,
      content: crushResult.sentinel
        ? `${crushResult.output}\n${crushResult.sentinel}`
        : crushResult.output,
    });
  }
  return result;
}

// ── Response-side helpers (R1–R4) ──────────────────────────────────────────

/**
 * Non-streaming un-redaction (R1: proxy.ts, R3: responses.ts).
 * Replaces all placeholders in `text` with their real values via the session
 * map.  When no session exists (redaction was off), returns the text unchanged.
 */
export function unredactResponseText(text: string, session?: MiddleSession): string {
  if (!session?.redaction) return text;
  return session.redaction.unredactText(text);
}

/**
 * Create a streaming un-redactor (R2: proxy.ts, R4: responses.ts).
 * Returns `null` when no session exists (redaction was off) so the call site
 * can skip wrapping entirely.
 */
export function createStreamUnredactor(session?: MiddleSession): StreamUnredactor | null {
  if (!session?.redaction) return null;
  return new StreamUnredactor(session.redaction.getMap());
}

/**
 * Non-streaming inbound interceptor (R1/R3 only — streaming R2/R4 skip AI
 * detection per D2).  Scans the model's response text for new secrets the
 * model emitted, adds them to the store, and re-redacts the text so the
 * client sees placeholders for model-emitted new secrets.
 */
export async function interceptInboundText(
  text: string,
  session?: MiddleSession,
): Promise<{ text: string; newSecretsFound: boolean }> {
  if (!session?.redaction) return { text, newSecretsFound: false };
  return interceptInbound(text, session.redaction);
}
