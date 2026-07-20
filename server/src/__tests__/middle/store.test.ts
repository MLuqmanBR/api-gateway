import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, getDb } from '../../db/index.js';
import {
  initSecretsStore,
  addSecret,
  removeSecret,
  setEnabled,
  listSecrets,
  getActiveSecretsForRedaction,
  _resetCacheForTesting,
} from '../../middle/redaction/store.js';

let tempDir: string;

beforeEach(() => {
  // Fresh DB + fresh temp data dir for every test. NEVER touches server/data/.
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  tempDir = join(tmpdir(), `middle-secrets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  initSecretsStore(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetCacheForTesting();
});

describe('SecretsStore — round-trip persistence', () => {
  it('persists secrets across a cache reset (simulates server restart)', () => {
    addSecret('sk-secret-key-123', 'api_key', 'manual', 'my-key');
    addSecret('user@example.com', 'email', 'manual');

    // Reset cache to force re-read from disk
    _resetCacheForTesting();

    const active = getActiveSecretsForRedaction();
    expect(active).toHaveLength(2);
    expect(active.some(s => s.value === 'sk-secret-key-123')).toBe(true);
    expect(active.some(s => s.value === 'user@example.com')).toBe(true);
  });

  it('writes the encrypted file to disk', () => {
    addSecret('tok_abc123', 'api_key', 'manual');
    const file = join(tempDir, 'middle-secrets.enc');
    const stat = statSync(file);

    // File should be encrypted — plaintext value must NOT appear
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('tok_abc123');
    expect(raw).toContain('encrypted'); // JSON envelope shape
  });

  it('sets file permissions to 0600', () => {
    addSecret('secret-value', 'api_key', 'manual');
    const file = join(tempDir, 'middle-secrets.enc');
    const stat = existsSync(file) ? require('fs').statSync(file) : null;
    // Skip mode check on platforms where chmod is advisory (Windows)
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe('SecretsStore — dedupe', () => {
  it('returns existing id for duplicate value', () => {
    const id1 = addSecret('same-value', 'api_key', 'manual', 'first');
    const id2 = addSecret('same-value', 'api_key', 'manual', 'second');
    expect(id1).toBe(id2);

    const active = getActiveSecretsForRedaction();
    expect(active).toHaveLength(1); // not duplicated
  });
});

describe('SecretsStore — tampered file handling', () => {
  it('treats a tampered file as an empty store without crashing', () => {
    addSecret('real-secret', 'api_key', 'manual');

    // Corrupt the file
    const file = join(tempDir, 'middle-secrets.enc');
    writeFileSync(file, '{"encrypted":"deadbeef","iv":"aabb","authTag":"ccdd"}', 'utf8');

    _resetCacheForTesting();
    const active = getActiveSecretsForRedaction();
    expect(active).toHaveLength(0); // empty, not crashed
  });
});

describe('SecretsStore — cache invalidation', () => {
  it('invalidates cache on add', () => {
    expect(getActiveSecretsForRedaction()).toHaveLength(0);
    addSecret('first', 'api_key', 'manual');
    expect(getActiveSecretsForRedaction()).toHaveLength(1);
    addSecret('second', 'api_key', 'manual');
    expect(getActiveSecretsForRedaction()).toHaveLength(2);
  });

  it('invalidates cache on remove', () => {
    const id = addSecret('removable', 'api_key', 'manual');
    expect(getActiveSecretsForRedaction()).toHaveLength(1);
    removeSecret(id);
    expect(getActiveSecretsForRedaction()).toHaveLength(0);
  });

  it('excludes disabled secrets from active set', () => {
    const id = addSecret('disable-me', 'api_key', 'manual');
    expect(getActiveSecretsForRedaction()).toHaveLength(1);
    setEnabled(id, false);
    expect(getActiveSecretsForRedaction()).toHaveLength(0);
    // But the secret still exists in the store (can be re-enabled)
    setEnabled(id, true);
    expect(getActiveSecretsForRedaction()).toHaveLength(1);
  });
});

describe('SecretsStore — listSecrets (metadata only)', () => {
  it('returns metadata without plaintext values', () => {
    addSecret('sk-super-secret-key', 'api_key', 'manual', 'prod-key');
    const metas = listSecrets();
    expect(metas).toHaveLength(1);
    expect(metas[0].kind).toBe('api_key');
    expect(metas[0].label).toBe('prod-key');
    expect(metas[0].addedBy).toBe('manual');
    expect(metas[0].enabled).toBe(true);
    // masked_preview should NOT contain the full secret
    expect(metas[0].maskedPreview).not.toContain('super-secret-key');
    expect(metas[0].maskedPreview).toContain('...');
  });

  it('removes metadata from DB on removeSecret', () => {
    const id = addSecret('temp-secret', 'api_key', 'manual');
    expect(listSecrets()).toHaveLength(1);
    removeSecret(id);
    expect(listSecrets()).toHaveLength(0);
  });
});
