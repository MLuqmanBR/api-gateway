/**
 * F2 (β): Error classification for typed fallback routing.
 *
 * Two surviving routing classes (the COOLDOWN path ignores this entirely —
 * everything is flat 90s via X1):
 *   - ContextWindowExceeded: REQUEST-side — the prompt is too large for the
 *     model's context window (detected pre-call at router.ts:574). Route to a
 *     model with a LARGER context_window.
 *   - ContentPolicyViolation: UPSTREAM-error-side — the provider rejected the
 *     content (400/403 with policy keywords). Route to a DIFFERENT model
 *     (not just a different key on the same model).
 *   - Transient: everything else (429, 5xx, timeout, transport). Route to
 *     the next key/model in the standard fallback chain.
 *
 * License: concept-only (litellm S3 MIT, tokenomics S9 MIT).
 */

export type ErrorClass = 'context_window_exceeded' | 'content_policy_violation' | 'transient';

/** Classify an upstream error for routing decisions. The COOLDOWN path
 *  ignores this — duration is always flat 90s (X1). The class only decides
 *  WHICH model to try next in the typed fallback chain. */
export function classifyError(err: any): ErrorClass {
  if (!err) return 'transient';
  const status = typeof err.status === 'number' ? err.status : undefined;
  const msg = (err.message ?? '').toLowerCase();

  // Content policy: upstream 400/403 with content-policy keywords
  if ((status === 400 || status === 403) && (
    msg.includes('content policy') || msg.includes('content_filter')
    || msg.includes('safety') || msg.includes('prohibited')
    || msg.includes('inappropriate') || msg.includes('not allowed')
  )) {
    return 'content_policy_violation';
  }

  // Context window: upstream error mentioning context length / token limit
  if (msg.includes('context length') || msg.includes('maximum context')
    || msg.includes('token limit') || msg.includes('too long')
    || msg.includes('prompt is too long') || msg.includes('contextwindowexceeded')) {
    return 'context_window_exceeded';
  }

  return 'transient';
}

/** Check if an error is a content-policy violation (for routing skip). */
export function isContentPolicyViolation(err: any): boolean {
  return classifyError(err) === 'content_policy_violation';
}

/** Check if an error is a context-window exceeded (for routing escalation). */
export function isContextWindowExceeded(err: any): boolean {
  return classifyError(err) === 'context_window_exceeded';
}
