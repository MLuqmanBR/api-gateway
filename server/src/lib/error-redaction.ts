const MAX_PROVIDER_ERROR_LENGTH = 240;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  [/\b(api[_-]?key|access[_-]?token|token|secret|authorization)(\s*[:=]\s*)(["']?)[^"',\s}\]]+/gi, '$1$2$3[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bgsk_[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bapi-gateway-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]'],
  [/\bhttps?:\/\/[^\s"'<>)]*/gi, '[redacted-url]'],
];

// Public documentation hosts are safe to keep in provider error messages —
// they usually point at the exact fix. Everything else still gets
// '[redacted-url]' from the generic rule above (audit L55).
const SAFE_DOCS_URL_RE =
  /\bhttps?:\/\/(?:docs\.[a-z0-9.-]+|[a-z0-9.-]+\.readme\.io|(?:www\.)?github\.com|developer\.mozilla\.org|stackoverflow\.com)\/[^\s"'<>)]*/gi;
// Private-use sentinels wrapping kept URLs while the redaction passes run —
// characters that never occur in provider error text.
const KEEP_OPEN = '\uE000';
const KEEP_CLOSE = '\uE001';

// High-entropy token redaction — runs AFTER the prefix patterns above so
// known-prefix tokens (sk-, gsk_, api-gateway-, AIza, JWT-shape) are already
// matched. Catches long opaque tokens that don't match any known prefix:
// provider-issued bearer tokens, HMAC signatures, opaque error-correlation
// ids. A pure regex can't express entropy, so we match long alphanumeric
// runs and gate on a Shannon-entropy floor to avoid false-positives on
// long English words or path components. (Imp 34)
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
// bits/char — common English prose is ~1-2, hex/base64/random tokens are
// ~3.5-6. 3.5 keeps real tokens while sparing long technical terms.
const ENTROPY_FLOOR = 3.5;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function sanitizeProviderErrorMessage(message: unknown): string {
  let sanitized = typeof message === 'string' ? message : String(message ?? '');
  sanitized = sanitized.trim();

  if (!sanitized) return 'Provider error';

  // Stash safe docs links so the generic URL rule and the entropy pass
  // can't touch them; restored verbatim at the end.
  const kept: string[] = [];
  sanitized = sanitized.replace(SAFE_DOCS_URL_RE, (url) => {
    kept.push(url);
    return `${KEEP_OPEN}${kept.length - 1}${KEEP_CLOSE}`;
  });

  for (const [pattern, replacement] of REDACTIONS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  // High-entropy pass — only redacts runs whose entropy exceeds the floor,
  // leaving long low-entropy words (English, path components) untouched.
  sanitized = sanitized.replace(HIGH_ENTROPY_PATTERN, (match) =>
    shannonEntropy(match) >= ENTROPY_FLOOR ? '[redacted-token]' : match,
  );
  sanitized = sanitized.replace(/\uE000(\d+)\uE001/g, (_, i) => kept[Number(i)] ?? '');
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  if (sanitized.length > MAX_PROVIDER_ERROR_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_PROVIDER_ERROR_LENGTH - 3).trimEnd()}...`;
  }

  return sanitized;
}
