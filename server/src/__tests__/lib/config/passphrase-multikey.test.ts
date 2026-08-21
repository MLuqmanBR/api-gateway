// C14 regression: a passphrase export/import round-trip must preserve every
// key per platform (keyed platform+label), not collapse them to the last one.
import { initDb, getDb } from '../../../db/index.js';
import { encrypt, decrypt } from '../../../lib/crypto.js';
import { buildExport } from '../../../lib/config/export.js';
import { runImport } from '../../../lib/config/import.js';
import { decryptKeysWithPassphrase, encryptKeysWithPassphrase } from '../../../lib/config/passphrase-crypto.js';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64);
  initDb(':memory:');
});

function insertKey(platform: string, label: string, value: string): void {
  const enc = encrypt(value);
  getDb().prepare(
    `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
     VALUES (?, ?, ?, ?, ?, 'unknown', 1)`,
  ).run(platform, label, enc.encrypted, enc.iv, enc.authTag);
}

function readKeys(): Array<{ platform: string; label: string; value: string }> {
  const rows = getDb().prepare('SELECT platform, label, encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
  return rows.map((r) => ({
    platform: r.platform,
    label: r.label,
    value: decrypt(r.encrypted_key, r.iv, r.auth_tag),
  }));
}

describe('C14 — passphrase round-trip keeps per-label key diversity', () => {
  it('restores two keys on one platform with their own values', () => {
    insertKey('mockopenai', 'primary', 'KEY-AAA-1111');
    insertKey('mockopenai', 'backup', 'KEY-BBB-2222');

    const envelope = buildExport({ sections: ['api_keys'], passphrase: 'correct horse' });

    // Export must strip plaintext from the visible section…
    expect(envelope.sections.apiKeys).toBeDefined();
    for (const row of envelope.sections.apiKeys!) {
      expect(row.key).toBeUndefined();
    }
    // …and carry both values (with labels) in the cipher blob.
    expect(envelope.keysCipher).toBeDefined();
    const items = decryptKeysWithPassphrase(envelope.keysCipher!, 'correct horse');
    expect(items).toHaveLength(2);
    const byLabel = new Map(items.map((i) => [i.label, i.key]));
    expect(byLabel.get('primary')).toBe('KEY-AAA-1111');
    expect(byLabel.get('backup')).toBe('KEY-BBB-2222');

    // Destination: wipe and re-import with the passphrase.
    getDb().prepare('DELETE FROM api_keys').run();
    const result = runImport({ envelope, options: { mode: 'overwrite', passphrase: 'correct horse' } });
    expect(result.api_keys?.errors ?? []).toHaveLength(0);

    const restored = readKeys().filter((k) => k.platform === 'mockopenai');
    expect(restored).toHaveLength(2);
    const primary = restored.find((k) => k.label === 'primary');
    const backup = restored.find((k) => k.label === 'backup');
    expect(primary?.value).toBe('KEY-AAA-1111');
    expect(backup?.value).toBe('KEY-BBB-2222');
  });

  it('legacy platform-only cipher items still import (back-compat)', () => {
    insertKey('mockopenai', 'only', 'KEY-OLD-9999');
    const envelope = buildExport({ sections: ['api_keys'], passphrase: 'pw' });
    // Rebuild the blob in the legacy shape (label-less items) — exactly
    // what an export produced before C14 contains.
    envelope.keysCipher = encryptKeysWithPassphrase(
      [{ platform: 'mockopenai', key: 'KEY-OLD-9999' }],
      'pw',
    );
    getDb().prepare('DELETE FROM api_keys').run();
    const result = runImport({ envelope, options: { mode: 'overwrite', passphrase: 'pw' } });
    expect(result.api_keys?.errors ?? []).toHaveLength(0);
    const restored = readKeys();
    expect(restored).toHaveLength(1);
    expect(restored[0].value).toBe('KEY-OLD-9999');
  });
});
