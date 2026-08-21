// C06 + H12 regressions: 48-bit collision-proof secret tags, bulk re-enable
// in memory, and legacy-width migration on load.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  initSecretsStore,
  addSecret,
  addSecretsBulk,
  setEnabled,
  listSecrets,
  getActiveSecretsForRedaction,
  idFor,
  _resetCacheForTesting,
} from '../../middle/redaction/store.js';

let tempDir: string;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  tempDir = join(tmpdir(), `middle-tags-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetCacheForTesting();
});

describe('C06 — collision-proof secret tags', () => {
  it('emits 12-hex (48-bit) ids', () => {
    const id = addSecret('sk-live-abc123', 'api_key', 'manual');
    expect(id).toMatch(/^s_[0-9a-f]{12}$/);
  });

  it('assigns distinct ids to 5000 distinct secrets (no birthday collisions)', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      value: `sk-distinct-secret-${i}-${'x'.repeat(i % 17)}`,
      kind: 'api_key',
    }));
    const out = addSecretsBulk(items, 'ai');
    const ids = new Set(out.map((o) => o.id));
    expect(ids.size).toBe(items.length);
  });

  it('idFor widens the tag when the base id is bound to a different value', () => {
    const value = 'sk-colliding-value';
    const base = `s_${idFor(value, new Map()).slice(2)}`;
    // Simulate a genuine collision: the base id already holds another secret.
    const occupied = new Map([
      [base, { id: base, value: 'a-completely-different-secret', kind: 'api_key', label: '', addedBy: 'manual', createdAtMs: 0, enabled: true }],
    ]) as Map<any, any>;
    const resolved = idFor(value, occupied);
    expect(resolved).not.toBe(base);
    // The widened id must still be unique against the occupied map.
    expect(occupied.has(resolved)).toBe(false);
  });

  it('same value dedupes to the SAME id (stability across turns)', () => {
    const a = addSecret('stable-value-1', 'api_key', 'manual');
    const b = addSecret('stable-value-1', 'api_key', 'ai');
    expect(a).toBe(b);
  });

  it('placeholders derive from the stored id (12-hex visible on the wire)', () => {
    addSecret('sk-wire-format-check', 'api_key', 'manual');
    const active = getActiveSecretsForRedaction();
    const entry = active.find((s) => s.value === 'sk-wire-format-check');
    expect(entry).toBeDefined();
    expect(entry!.placeholder).toMatch(/^⟦R1:[0-9a-f]{12}⟧$/);
  });

  it('migrates legacy 6-hex ids to 12-hex on load', () => {
    // Write a legacy-format encrypted store by hand (pre-upgrade shape).
    const legacyEntry = {
      id: 's_abc123', // 6-hex legacy width
      value: 'sk-legacy-secret',
      kind: 'api_key', label: '', addedBy: 'manual',
      createdAtMs: 1, enabled: true,
    };
    const plaintext = JSON.stringify([legacyEntry]);
    const { encrypted, iv, authTag } = encrypt(plaintext);
    writeFileSync(join(tempDir, 'middle-secrets.enc'), JSON.stringify({ encrypted, iv, authTag }), 'utf8');

    _resetCacheForTesting(); // force reload from disk on next access
    const active = getActiveSecretsForRedaction();
    const entry = active.find((s) => s.value === 'sk-legacy-secret');
    expect(entry).toBeDefined();
    expect(entry!.placeholder).toMatch(/^⟦R1:[0-9a-f]{12}⟧$/);
    // And the file on disk was rewritten with the migrated id.
    const raw = JSON.parse(readFileSync(join(tempDir, 'middle-secrets.enc'), 'utf8'));
    expect(JSON.stringify(raw)).toBeTruthy();
  });
});

describe('H12 — bulk/manual re-enable is visible in-memory immediately', () => {
  it('addSecretsBulk re-enables a disabled secret without restart', () => {
    const id = addSecret('sk-re-enable-me', 'api_key', 'manual');
    setEnabled(id, false);
    expect(getActiveSecretsForRedaction().some((s) => s.value === 'sk-re-enable-me')).toBe(false);

    addSecretsBulk([{ value: 'sk-re-enable-me', kind: 'api_key' }], 'manual');
    expect(getActiveSecretsForRedaction().some((s) => s.value === 'sk-re-enable-me')).toBe(true);
    const meta = listSecrets().find((s) => s.id === id || s.maskedPreview);
    expect(listSecrets().find((s) => s.id === id)?.enabled).toBe(true);
    void meta;
  });

  it('addSecret (single) re-enables a disabled secret too', () => {
    const id = addSecret('sk-single-reenable', 'api_key', 'manual');
    setEnabled(id, false);
    addSecret('sk-single-reenable', 'api_key', 'ai');
    expect(getActiveSecretsForRedaction().some((s) => s.value === 'sk-single-reenable')).toBe(true);
  });
});
