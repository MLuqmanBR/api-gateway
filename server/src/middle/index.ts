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

// ── Per-request session ────────────────────────────────────────────────────

export interface MiddleSession {
  redaction: RedactionSession;
  /** True after the Stage-2 AI interceptor has run at least once.  Gates
   * subsequent attempts to skip the interceptor and re-run Stage-1 only. */
  interceptorRan: boolean;
  metrics: { tokensBefore: number; tokensAfter: number; tokensSaved: number };
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

  if (cfg.redactionEnabled) {
    // Existing session (retry/fallback) → Stage-1 only, reuse the session.
    if (session?.redaction) {
      const redacted = session.redaction.redactOutbound(messages);
      return { messages: redacted, session };
    }

    // First attempt → Stage-1 programmatic + Stage-2 AI interceptor.
    const secrets = getActiveSecretsForRedaction();
    const redactionSession = new RedactionSession(secrets);
    const redacted = redactionSession.redactOutbound(messages);
    const intercepted = await interceptOutbound(redacted, redactionSession);
    return {
      messages: intercepted.messages,
      session: {
        redaction: redactionSession,
        interceptorRan: true,
        metrics: { tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 },
      },
    };
  }

  // Compression only (B1, not yet implemented — pass through unchanged).
  return { messages };
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
