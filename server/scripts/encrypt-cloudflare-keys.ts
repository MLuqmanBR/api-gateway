#!/usr/bin/env -S npx tsx
/**
 * One-shot script to insert Cloudflare account keys into the api_keys table
 * (platform='cloudflare'), AES-256-GCM encrypted with ENCRYPTION_KEY from the
 * environment or the project .env file.
 *
 *        npx tsx server/scripts/encrypt-cloudflare-keys.ts
 *
 * The key set comes from the KEY_SETS_JSON env var (a JSON array of
 * { "label": "<email>", "raw": "<account_id>:<api_token>" } objects); nothing
 * is deleted or deduplicated — existing rows are left untouched.
 */

import crypto from 'crypto';
import { createDatabase } from '../src/db/backend.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DB_PATH = resolve(REPO_ROOT, 'server/data/api-gateway.db');
const ENV_PATH = resolve(REPO_ROOT, '.env');

// Load .env manually (avoid extra dep on dotenv)
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const env = loadEnv(ENV_PATH);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  console.error('FATAL: ENCRYPTION_KEY not found in .env or environment');
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(ENCRYPTION_KEY)) {
  console.error('FATAL: ENCRYPTION_KEY must be 64 hex chars');
  process.exit(1);
}


function encrypt(text) {
  // 12-byte nonce — the GCM standard, matching server/src/lib/crypto.ts.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

// Cloudflare account keys (account_id:api_token) — as many as KEY_SETS_JSON
// provides; there is no fixed count.
// IMPORTANT: Provide real tokens via KEY_SETS_JSON env var — NEVER commit
// real tokens to git. GitHub push protection blocks them.
// Format: [{ "label": "<email>", "raw": "<account_id>:<api_token>" }]
const KEY_SETS_JSON = process.env.KEY_SETS_JSON || '[]';
let KEY_SETS;
try {
  KEY_SETS = JSON.parse(KEY_SETS_JSON);
} catch {
  KEY_SETS = [];
}
if (KEY_SETS.length === 0) {
  console.error('FATAL: Provide Cloudflare key data via KEY_SETS_JSON env var.');
  console.error('  KEY_SETS_JSON=\'[{"label":"user@example.com","raw":"ACCOUNT_ID:API_TOKEN"}]\' \\');
  console.error('  npx tsx server/scripts/encrypt-cloudflare-keys.ts');
  process.exit(1);
}

const db = createDatabase(DB_PATH);
db.pragma('journal_mode = WAL');

const insert = db.prepare(`
  INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at)
  VALUES ('cloudflare', @label, @encrypted_key, @iv, @auth_tag, 'unknown', 1, datetime('now'))
`);

const insertMany = db.transaction((rows) => {
  for (const row of rows) {
    insert.run(row);
  }
});

const rows = KEY_SETS.map(({ label, raw }) => {
  const { encrypted, iv, authTag } = encrypt(raw);
  console.log(`  Encrypted ${label.slice(0, 18)}... -> iv=${iv.slice(0, 16)}...`);
  return {
    label,
    encrypted_key: encrypted,
    iv,
    auth_tag: authTag,
  };
});

console.log(`\nInserting ${rows.length} Cloudflare keys...`);
insertMany(rows);

const count = db.prepare("SELECT COUNT(*) as cnt FROM api_keys WHERE platform='cloudflare'").get();
console.log(`Done. api_keys count for cloudflare: ${count.cnt}`);

db.close();
console.log('Database closed.');
