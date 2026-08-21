import { describe, it, expect } from 'vitest';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';

describe('sanitizeProviderErrorMessage', () => {
  it('returns a default for empty input', () => {
    expect(sanitizeProviderErrorMessage('')).toBe('Provider error');
    expect(sanitizeProviderErrorMessage(undefined)).toBe('Provider error');
    expect(sanitizeProviderErrorMessage(null)).toBe('Provider error');
  });

  it('strips Bearer tokens', () => {
    const out = sanitizeProviderErrorMessage('Auth failed: Bearer abc123def456ghi789jkl012mno345pqr678stu901vwx234yz');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('abc123def456');
  });

  it('strips sk- prefixed keys', () => {
    const out = sanitizeProviderErrorMessage('key sk-proj-1234567890abcdef is invalid');
    expect(out).toContain('[redacted-key]');
    expect(out).not.toContain('sk-proj-');
  });

  it('strips gsk_ prefixed keys', () => {
    const out = sanitizeProviderErrorMessage('gsk_abcdef1234567890ghijkl is invalid');
    expect(out).toContain('[redacted-key]');
    expect(out).not.toContain('gsk_abcdef');
  });

  it('strips api-gateway- prefixed keys', () => {
    const out = sanitizeProviderErrorMessage('key api-gateway-abcdef1234567890ghijklmnop is invalid');
    expect(out).toContain('[redacted-key]');
    expect(out).not.toContain('api-gateway-abcdef');
  });

  it('strips AIza prefixed keys', () => {
    const out = sanitizeProviderErrorMessage('AIzaSyA1234567890_-abcdefghijklmnopqrstuvwxyz');
    expect(out).toContain('[redacted-key]');
    expect(out).not.toContain('AIzaSyA');
  });

  it('strips JWT-shape tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = sanitizeProviderErrorMessage(`token ${jwt} expired`);
    expect(out).toContain('[redacted-token]');
    expect(out).not.toContain('eyJhbGci');
  });

  it('strips URLs', () => {
    const out = sanitizeProviderErrorMessage('see https://api.example.com/v1/models for details');
    expect(out).toContain('[redacted-url]');
    expect(out).not.toContain('api.example.com');
  });

  it('keeps public docs links while stripping other URLs (L55 allowlist)', () => {
    const out = sanitizeProviderErrorMessage(
      'rate limited — see https://docs.anthropic.com/en/docs/rate-limits and https://api.example.com/v1/models',
    );
    expect(out).toContain('https://docs.anthropic.com/en/docs/rate-limits');
    expect(out).toContain('[redacted-url]');
    expect(out).not.toContain('api.example.com');
  });

  it('strips high-entropy tokens adjacent to key/token/secret words', () => {
    // A 64-char hex token next to "api_key" (no : or = so the key-word regex
    // does not fire — the high-entropy pass catches it instead).
    const hex64 = 'a3f2c9e8b1d4f7a6c0e3b2d9f8a1c4e7b0d3f2a9c8e1b4d7f0a3c2e9b8d1f4a7';
    const out = sanitizeProviderErrorMessage(`api_key ${hex64} is unauthorized`);
    expect(out).not.toContain(hex64);
    expect(out).toContain('[redacted-token]');
  });

  it('strips a long high-entropy bearer token without a known prefix', () => {
    // 48-char opaque token — no sk-/gsk_/AIza/api-gateway prefix, not JWT shape
    const opaque = 'X7mKpR9wL2nQ4vB8jF6cZ3hT1yA5sD0gU9iE4rN2bV7xM3kP6qJ1oW5tL8dG0fH';
    const out = sanitizeProviderErrorMessage(`Authorization header value ${opaque} rejected`);
    // The Bearer rule may not match (no "Bearer" prefix), but the
    // api_key/token/secret/authorization regex matches "Authorization...value"
    // and the high-entropy pass catches the bare token.
    expect(out).not.toContain(opaque);
  });

  it('preserves a normal English sentence (entropy floor prevents false positives)', () => {
    // A 40-char sentence — low entropy, has spaces so won't match the 32+ run
    const sentence = 'The model returned an error because the context window was exceeded';
    const out = sanitizeProviderErrorMessage(sentence);
    expect(out).toContain('context window was exceeded');
    // Should not have redacted any part of normal prose
    expect(out).not.toContain('[redacted]');
  });

  it('preserves long technical words that are low-entropy', () => {
    // A 35-char single word but low entropy (repetitive chars) — won't be redacted
    const word = 'pneumonoultramicroscopicsilicovolcanoconiosiss';
    const out = sanitizeProviderErrorMessage(`disease ${word} caused the error`);
    expect(out).toContain(word);
  });
  it('strips Authorization Bearer with a long token', () => {
    // The Bearer regex runs first and consumes the token; the authorization
    // key-word regex then eats the "Bearer" word. Both produce [redacted].
    const token = 'eyJ' + 'A'.repeat(60) + '_-_';
    const out = sanitizeProviderErrorMessage(`Authorization: Bearer ${token} failed`);
    expect(out).not.toContain('AAAA');
    expect(out).toContain('[redacted]');
  });

  it('truncates long messages to MAX length', () => {
    const long = 'Error: ' + 'a'.repeat(300);
    const out = sanitizeProviderErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out).toMatch(/\.\.\.$/);
  });

  it('collapses whitespace', () => {
    const out = sanitizeProviderErrorMessage('error    with\n\nmultiple\t\tspaces');
    expect(out).not.toContain('  ');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\t');
  });
});
