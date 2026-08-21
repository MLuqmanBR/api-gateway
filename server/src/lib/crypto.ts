import crypto from 'crypto';
import type { DatabasePort } from '../db/types.js';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

// Outside production we auto-generate and persist a key so a fresh clone
// (`npm run dev`) boots without manual setup — the placeholder ENCRYPTION_KEY
// in .env.example would otherwise crash the server on boot, which surfaces in
// the client as "Can't reach the server". Production still requires an explicit
// env key: a generated key lives only in the local DB and silently losing it
// would make every stored API key undecryptable.
function isDevFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required in production for API key encryption. ' +
    `Set a ${KEY_HEX_LEN}-char hex key (generate one with: ` +
    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"). ` +
    'Outside production a local DB-stored key is auto-generated.',
  );
}

/**
 * Initialize encryption key from env or an explicit local-dev fallback.
 * Must be called after DB is initialized.
 */
export function initEncryptionKey(db: DatabasePort): void {
  // 1. Check env var
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    cachedKey = parseHexKey(envKey, 'env');
    return;
  }

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  // 2. Check DB for persisted key
  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  if (row) {
    cachedKey = parseHexKey(row.value, 'db');
    console.warn('[crypto] No ENCRYPTION_KEY set — using auto-generated key from the local DB (dev only).');
    return;
  }

  // 3. Generate and persist
  cachedKey = crypto.randomBytes(KEY_BYTES);
  db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
  console.warn('[crypto] No ENCRYPTION_KEY set — generated and persisted a local dev key. Set ENCRYPTION_KEY for production.');
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // GCM standard nonce is 12 bytes
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  // M45: short keys revealed 3/4 of their content ('abcd' → '****bcd').
  // Only show a tail when at least half the key stays hidden.
  if (key.length <= 6) return '****';
  return '****' + key.slice(-3);
}

// ---- F3: client key hashing (scrypt) ----
// scrypt is Node's stdlib KDF — slower than plain SHA-256 but standard for
// cross-tool interop. The secret format is <key_id>:<secret> so the auth
// flow can do an O(1) PK lookup BEFORE the scrypt (avoids O(N) scrypt DoS
// when multiple client keys exist). Routiium S5 concept (Apache-2.0,
// github.com/labiium/routiium).

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/** Generate a 16-byte salt as hex. */
export function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Generate a client key id in the form ck_<uuid>. */
export function generateClientKeyId(): string {
  return 'ck_' + crypto.randomUUID().replace(/-/g, '');
}

/** Generate a 24-hex-char client secret. */
export function generateClientSecret(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** Hash a client secret with its salt using scrypt. Returns hex hash. */
export function hashClientSecret(secret: string, salt: string): string {
  return crypto.scryptSync(secret, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  }).toString('hex');
}

/** Timing-safe comparison of two hex hash strings. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
