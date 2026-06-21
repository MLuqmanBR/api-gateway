// End-to-end self-test for the import + preview paths. Three scenarios:
//
//   1. User's real backup file (when present at the Downloads path).
//   2. Synthetic passphrase-protected envelope with 64 keys — exercises
//      the keysByPlatform path through both preview (encrypted-with-passphrase)
//      and runImport (clean decrypt under FRESH_KEY).
//   3. Synthetic no-passphrase envelope with foreign-key ciphertext —
//      exercises the safety net: preview reports `mismatch`, runImport
//      refuses every row with a clear error and surfaces the diagnostic.
//
// All scenarios run against a sandbox DB and a brand-new ENCRYPTION_KEY.
// The script does NOT touch the live server DB.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, getDb } from '../server/src/db/index.ts';
import { runImport, previewEnvelope, probeKeyCompatibility } from '../server/src/lib/config/import.ts';
import { decrypt } from '../server/src/lib/crypto.ts';
import { encryptKeysWithPassphrase } from '../server/src/lib/config/passphrase-crypto.ts';
import type { ConfigEnvelope } from '../shared/types.ts';

const USER_BACKUP_PATH = path.join(
  os.homedir(),
  'Downloads',
  'API_Gateway-Backup-fully-functioning-2026-06-21-05-35-31.json',
);
const PASSPHRASE = 'Namqul@07';

interface Scenario {
  name: string;
  build: () => ConfigEnvelope;
  importOptions: { passphrase?: string; mode: 'overwrite' | 'replace' | 'skip-existing'; sections?: ('api_keys')[] };
  expectProbe: 'no-keys' | 'encrypted-with-passphrase' | 'plaintext' | 'compatible' | 'mismatch';
  expectImportAdded: number;
  expectImportErrors: number;
}

function buildKeysCipherEnvelopes(): Scenario {
  return {
    name: 'passphrase-protected synthetic envelope (64 keys across 8 platforms)',
    build: () => {
      const platforms = ['groq', 'cerebras', 'openrouter', 'cloudflare', 'nvidia', 'cohere', 'github', 'mistral'];
      const rows = Array.from({ length: 64 }, (_, i) => ({
        platform: platforms[i % platforms.length],
        label: `key-${i}`,
        enabled: true,
        // The plaintext value to wrap in keysCipher.
        _plain: `sk-secret-value-${i}-${crypto.randomBytes(8).toString('hex')}`,
      }));
      const cipher = encryptKeysWithPassphrase(
        rows.map((r) => ({ platform: r.platform, key: r._plain as string })),
        PASSPHRASE,
      );
      // Build apiKey rows that ALSO carry per-row ciphertext — matches
      // what the exporter actually emits. The ciphertext is the row's
      // own plaintext re-encrypted under the test key; the keysCipher
      // path will prefer the keysCipher plaintext anyway, so the row
      // ciphertext is essentially decorative here.
      const apiKeys = rows.map((r) => {
        const plain = r._plain as string;
        // Encrypt under the destination's key by calling AES directly
        // (we can't use the shared encrypt() here because the import
        // service caches the destination key at module load).
        const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex');
        const iv = crypto.randomBytes(16);
        const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ct = Buffer.concat([enc.update(Buffer.from(plain, 'utf8')), enc.final()]);
        return {
          platform: r.platform,
          label: r.label,
          enabled: true,
          encryptedKey: ct.toString('hex'),
          iv: iv.toString('hex'),
          authTag: enc.getAuthTag().toString('hex'),
        };
      });
      return {
        schemaVersion: 1,
        generator: 'api-gateway',
        exportedAt: new Date().toISOString(),
        sections: { apiKeys },
        keysCipher: cipher,
      };
    },
    importOptions: { passphrase: PASSPHRASE, mode: 'overwrite', sections: ['api_keys'] },
    expectProbe: 'encrypted-with-passphrase',
    expectImportAdded: 64,
    expectImportErrors: 0,
  };
}

function buildMismatchEnvelopes(): Scenario {
  return {
    name: 'no-passphrase envelope with foreign-key ciphertext',
    build: () => {
      // Ciphertext encrypted under a DIFFERENT key than the
      // destination's — the safety net should refuse every row.
      const foreign = crypto.randomBytes(32);
      const apiKeys = Array.from({ length: 12 }, (_, i) => {
        const plain = `sk-foreign-${i}`;
        const iv = crypto.randomBytes(16);
        const enc = crypto.createCipheriv('aes-256-gcm', foreign, iv);
        const ct = Buffer.concat([enc.update(Buffer.from(plain, 'utf8')), enc.final()]);
        return {
          platform: i % 2 === 0 ? 'groq' : 'openrouter',
          label: `key-${i}`,
          enabled: true,
          encryptedKey: ct.toString('hex'),
          iv: iv.toString('hex'),
          authTag: enc.getAuthTag().toString('hex'),
        };
      });
      return {
        schemaVersion: 1,
        generator: 'api-gateway',
        exportedAt: new Date().toISOString(),
        sections: { apiKeys },
      };
    },
    importOptions: { mode: 'overwrite', sections: ['api_keys'] },
    expectProbe: 'mismatch',
    expectImportAdded: 0,
    expectImportErrors: 12,
  };
}

function buildUserBackupScenario(env: ConfigEnvelope): Scenario {
  return {
    name: "user's real backup file (apiKeys + keysCipher + non-key sections)",
    build: () => env,
    importOptions: { passphrase: PASSPHRASE, mode: 'overwrite' },
    expectProbe: env.keysCipher ? 'encrypted-with-passphrase' : 'compatible',
    expectImportAdded: (env.sections.apiKeys || []).length,
    expectImportErrors: 0,
  };
}

async function runScenario(s: Scenario): Promise<{ pass: boolean; notes: string[] }> {
  const notes: string[] = [];
  const envelope = s.build();

  // ── Preview path ─────────────────────────────────────────────────────
  const probe = probeKeyCompatibility(envelope);
  notes.push(`probe=${probe}`);
  if (probe !== s.expectProbe) {
    return { pass: false, notes: [...notes, `expected probe=${s.expectProbe}`] };
  }

  const preview = previewEnvelope(envelope);
  if (preview.keyCompatibility !== s.expectProbe) {
    return { pass: false, notes: [...notes, `previewEnvelope returned ${preview.keyCompatibility}`] };
  }

  // ── Import path ──────────────────────────────────────────────────────
  const SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-verify-'));
  const SANDBOX_DB = path.join(SANDBOX_DIR, 'sandbox.db');
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  try {
    initDb(SANDBOX_DB);
    const result = runImport({ envelope, options: s.importOptions });
    const ak = result.sections.api_keys;
    const errors = ak?.errors?.length ?? 0;
    notes.push(`added=${ak?.added ?? 0}, errors=${errors}`);
    notes.push(`summary.keyCompatibility=${JSON.stringify(result.keyCompatibility)}`);

    if ((ak?.added ?? 0) !== s.expectImportAdded) {
      return { pass: false, notes: [...notes, `expected added=${s.expectImportAdded}`] };
    }
    if (errors !== s.expectImportErrors) {
      return { pass: false, notes: [...notes, `expected errors=${s.expectImportErrors}`] };
    }

    // For the success path, verify every row actually decrypts under
    // the freshly generated key.
    if (errors === 0 && (ak?.added ?? 0) > 0) {
      const db = getDb();
      const rows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as Array<{
        encrypted_key: string; iv: string; auth_tag: string;
      }>;
      let decryptedOk = 0;
      for (const r of rows) {
        try { decrypt(r.encrypted_key, r.iv, r.auth_tag); decryptedOk++; } catch { /* ignore */ }
      }
      notes.push(`post-import decrypt=${decryptedOk}/${rows.length}`);
      if (decryptedOk !== rows.length) {
        return { pass: false, notes: [...notes, 'not every row decrypts'] };
      }
    }

    // For the mismatch path, verify keyCompatibility reports it.
    if (s.expectImportErrors > 0 && result.keyCompatibility?.status !== 'mismatch') {
      return { pass: false, notes: [...notes, 'keyCompatibility should be mismatch'] };
    }
  } finally {
    try { fs.rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { pass: true, notes };
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'development';
  const scenarios: Scenario[] = [buildKeysCipherEnvelopes(), buildMismatchEnvelopes()];

  if (fs.existsSync(USER_BACKUP_PATH)) {
    const userEnvelope = JSON.parse(fs.readFileSync(USER_BACKUP_PATH, 'utf8')) as ConfigEnvelope;
    scenarios.unshift(buildUserBackupScenario(userEnvelope));
    console.log('User backup file found:', USER_BACKUP_PATH);
  } else {
    console.log('User backup file NOT found at', USER_BACKUP_PATH, '— running synthetic scenarios only.');
  }

  let pass = 0;
  let fail = 0;
  for (const s of scenarios) {
    console.log('');
    console.log('▶', s.name);
    const r = await runScenario(s);
    for (const n of r.notes) console.log('   ·', n);
    if (r.pass) {
      pass++;
      console.log('  ✓ PASS');
    } else {
      fail++;
      console.log('  ✗ FAIL');
    }
  }
  console.log('');
  console.log(`Scenarios: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-import crashed:', err);
  process.exit(2);
});
