import { initDb, getDb } from './src/db/index.js';
import { resolveAudioEndpoint } from './src/services/transcriptions.js';

initDb(':memory:');
const db = getDb();

const platforms = ['groq', 'mistral', 'openrouter', 'ovh', 'zhipu'];
for (const p of platforms) {
  console.log(`BUILTIN ${p} -> ${resolveAudioEndpoint(p, 'transcriptions')}`);
}

// Insert two custom providers: one plain /v1, one with trailing slash.
db.prepare(`INSERT INTO custom_providers (slug, display_name, base_url, api_format) VALUES (?,?,?,?)`)
  .run('customplain', 'Custom Plain', 'https://example.test/v1', 'openai');
db.prepare(`INSERT INTO custom_providers (slug, display_name, base_url, api_format) VALUES (?,?,?,?)`)
  .run('customslash', 'Custom Slash', 'https://example.test/v1/', 'openai');

console.log(`CUSTOM customplain (stored https://example.test/v1) -> ${resolveAudioEndpoint('customplain', 'transcriptions')}`);
console.log(`CUSTOM customslash (stored https://example.test/v1/) -> ${resolveAudioEndpoint('customslash', 'transcriptions')}`);
console.log(`CUSTOM unknown-slug -> ${resolveAudioEndpoint('does-not-exist', 'transcriptions')}`);
console.log(`TRANSLATIONS groq -> ${resolveAudioEndpoint('groq', 'translations')}`);
