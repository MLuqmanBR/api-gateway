// Minimal structured logger for proxy/responses/health. Levels + a fixed
// field set (request id, provider, model, key id) so triage queries don't
// have to regex `console.log` output.
//
// All emitted messages pass through `sanitizeProviderErrorMessage` on the
// `message` slot — keys/URLs/Authorization headers don't reach the log.
//
// CLI/startup logs intentionally stay on console.* for now — converting
// them adds noise without triage value (they run once at boot, not in
// the per-request hot path).

import { sanitizeProviderErrorMessage } from './error-redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  requestId?: string;
  provider?: string;
  model?: string;
  keyId?: number;
  // Any other arbitrary structured fields the caller wants to attach.
  [extra: string]: unknown;
}

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: '[debug]',
  info: '[info]',
  warn: '[warn]',
  error: '[error]',
};

// Format a field value for the trailing `key=value` section. Strings and
// numbers are passed through verbatim; everything else is JSON-stringified
// (with the standard escape fallback for cyclic objects).
function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: LogLevel, msg: unknown, fields?: LogFields): void {
  const safeMsg = sanitizeProviderErrorMessage(msg);
  const tag = LEVEL_PREFIX[level];
  const fieldParts: string[] = [];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      // Trim long free-text messages inside field values to keep log lines
      // bounded (provider error stacks are typically >1KB).
      fieldParts.push(`${k}=${formatValue(k === 'message' ? sanitizeProviderErrorMessage(v) : v)}`);
    }
  }
  const tail = fieldParts.length > 0 ? ` ${fieldParts.join(' ')}` : '';
  const line = `${tag} ${safeMsg}${tail}`;
  // M16: every level goes to stderr so PM2/systemd log shippers can split
  // stdout/stderr by stream without losing the level signal. (Previously
  // info/debug used console.log → stdout, contradicting the comment above.)
  process.stderr.write(line + '\n');
}

export const logger = {
  debug: (msg: unknown, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: unknown, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: unknown, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: unknown, fields?: LogFields) => emit('error', msg, fields),
};
