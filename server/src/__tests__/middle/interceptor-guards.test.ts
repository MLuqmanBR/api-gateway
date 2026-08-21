// H02/H03/H04 regressions: interceptor scan-failure backoff, plausible-secret
// guard on model nominations, and quarantine-on-corruption for the secrets file.
import { writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  isScanned,
  markScanned,
  markScanFailed,
  extractNewSecrets,
  isPlausibleSecret,
  SCAN_FAILURE_RETRY_MS,
} from '../../middle/redaction/interceptor.js';
import { initSecretsStore, getActiveSecretsForRedaction, _resetCacheForTesting } from '../../middle/redaction/store.js';

let tempDir: string;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '2'.repeat(64);
  initDb(':memory:');
  tempDir = join(tmpdir(), `middle-h-fixes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetCacheForTesting();
  vi.useRealTimers();
});

describe('H02 — failed scans back off, then retry (not cached forever)', () => {
  it('a failed scan is skipped within the backoff window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const text = `retry-me-${Math.random()}`;
    markScanFailed(text);
    expect(isScanned(text)).toBe(true); // within window: not re-dispatched
  });

  it('a failed scan is retried once the backoff expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const text = `retry-me-2-${Math.random()}`;
    markScanFailed(text);
    vi.setSystemTime(1_000_000 + SCAN_FAILURE_RETRY_MS + 1);
    expect(isScanned(text)).toBe(false); // eligible for a fresh dispatch
  });

  it('a SUCCESSFUL scan is never rescanned this boot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const text = `done-${Math.random()}`;
    markScanned(text);
    vi.setSystemTime(1_000_000 + SCAN_FAILURE_RETRY_MS * 10);
    expect(isScanned(text)).toBe(true);
  });
});

describe('H03 — interceptor nominations must be plausible secrets', () => {
  const text = 'the user said contact me at sk-proj-abc123XYZ and the value is here';

  it('rejects common words the model may nominate', () => {
    expect(isPlausibleSecret('the', text)).toBe(false);
    expect(isPlausibleSecret('user', text)).toBe(false);
  });

  it('rejects short values; near-whole-message spans are ACCEPTED (a bare secret IS a valid message)', () => {
    expect(isPlausibleSecret('abc', text)).toBe(false);
    // Users paste bare PATs/API keys as whole messages — those must still
    // be redactable. The 40% relative-length cap was removed deliberately.
    expect(isPlausibleSecret(text.slice(0, Math.ceil(text.length * 0.9)), text)).toBe(true);
  });

  it('accepts real-looking token values', () => {
    expect(isPlausibleSecret('sk-proj-abc123XYZ', text)).toBe(true);
  });

  it('extractNewSecrets filters nominated spans through the guard', () => {
    const out = extractNewSecrets(text, [
      { exact: 'the', kind: 'person' },
      { exact: 'user', kind: 'person' },
      { exact: 'sk-proj-abc123XYZ', kind: 'api_key' },
      { exact: 'not-present-verbatim', kind: 'api_key' }, // verbatim rule still applies
    ]);
    expect(out).toEqual([{ value: 'sk-proj-abc123XYZ', kind: 'api_key' }]);
  });
});

describe('H04 — corrupt secrets file is quarantined, never overwritten', () => {
  it('quarantines the unreadable file and starts fresh', () => {
    const garbage = 'this is definitely not an encrypted payload';
    writeFileSync(join(tempDir, 'middle-secrets.enc'), garbage, 'utf8');
    _resetCacheForTesting(); // force reload

    const active = getActiveSecretsForRedaction();
    expect(active).toEqual([]);

    const quarantined = readdirSync(tempDir).filter((f) => f.startsWith('middle-secrets.enc.corrupt-'));
    expect(quarantined).toHaveLength(1);
    // The original bytes are preserved for potential recovery.
    expect(readFileSync(join(tempDir, quarantined[0]), 'utf8')).toBe(garbage);
  });
});
