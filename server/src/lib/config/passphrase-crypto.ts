// Passphrase-derived key encryption for the export envelope.
//
// The exported config often carries plaintext API keys (one per platform).
// Dropping them into a JSON file on the user's disk is fine — that's the
// user's machine — but a JSON file is also fine to leak through a typo'd
// `scp` or a chat screenshot. When the user opts in to a passphrase we
// encrypt the keys (only the keys, not the rest of the config — the rest is
// not sensitive) under a PBKDF2-SHA256 derivation of their passphrase and
// keep the rest of the envelope in the clear.
//
// Parameters: 310,000 iterations per OWASP 2023 password storage guidance.
// Salt is 16 bytes, IV is 12 bytes (AES-GCM), auth tag is 16 bytes.
import crypto from 'crypto';

const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_KEY_LEN = 32; // AES-256
const PBKDF2_DIGEST = 'sha256';
const SALT_LEN = 16;
const IV_LEN = 12;

export interface KeysCipher {
  kdf: 'pbkdf2-sha256-310000';
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    Buffer.from(passphrase, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    PBKDF2_DIGEST,
  );
}

/**
 * Encrypt `plaintextKeys` (a JSON-serialisable array of `{ platform, key }`
 * — small, ≤ 64 KB on disk even with dozens of platforms) under a
 * passphrase. The result is self-describing: the consumer only needs the
 * passphrase to recover the keys.
 */
export function encryptKeysWithPassphrase(
  plaintextKeys: Array<{ platform: string; key: string }>,
  passphrase: string,
): KeysCipher {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('passphrase must not be empty');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = Buffer.from(JSON.stringify(plaintextKeys), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    kdf: 'pbkdf2-sha256-310000',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypt a `keysCipher` blob produced by `encryptKeysWithPassphrase`. An
 * incorrect passphrase raises (GCM auth tag mismatch) — there's no
 * recoverable state to return. The caller should surface that as a 401-
 * style error: "wrong passphrase" is not knowable without trying.
 */
export function decryptKeysWithPassphrase(
  blob: KeysCipher,
  passphrase: string,
): Array<{ platform: string; key: string }> {
  if (blob.kdf !== 'pbkdf2-sha256-310000') {
    throw new Error(`Unsupported KDF: ${blob.kdf}`);
  }
  if (!passphrase) {
    throw new Error('passphrase required to decrypt keys');
  }
  const salt = Buffer.from(blob.salt, 'hex');
  const iv = Buffer.from(blob.iv, 'hex');
  const authTag = Buffer.from(blob.authTag, 'hex');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(json) as Array<{ platform: string; key: string }>;
  if (!Array.isArray(parsed)) {
    throw new Error('decrypted payload is not an array');
  }
  for (const row of parsed) {
    if (typeof row.platform !== 'string' || typeof row.key !== 'string') {
      throw new Error('decrypted payload has malformed entries');
    }
  }
  return parsed;
}
