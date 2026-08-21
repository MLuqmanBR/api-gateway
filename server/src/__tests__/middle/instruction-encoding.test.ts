// C15 regression: the redaction instruction must never contain mojibake
// (U+FFFD) — a corrupted byte previously produced a malformed placeholder
// example that was injected into every redacted request.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, '../../middle/index.ts'), 'utf8');

describe('REDACTION_INSTRUCTION encoding integrity (C15)', () => {
  it('contains no U+FFFD replacement characters', () => {
    expect(src.includes('\uFFFD')).toBe(false);
  });

  it('example line shows only fully-formed ⟦Rn:hex⟧ placeholders', () => {
    const exampleLine = src.split('\n').find((l) => l.includes('for example'));
    expect(exampleLine).toBeDefined();
    const placeholders = exampleLine!.match(/⟦R\d:[0-9a-f]+⟧/g) ?? [];
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
    // No placeholder should be malformed (opening without a proper closing).
    const opens = (exampleLine!.match(/⟦/g) ?? []).length;
    const closes = (exampleLine!.match(/⟧/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('N29: every example placeholder uses the current store generation (1)', () => {
    // STORE_GENERATION is 1 in middle/redaction/store.ts and has never been
    // bumped — examples advertising R2/R3 would describe tokens that can
    // never occur.
    const exampleLine = src.split('\n').find((l) => l.includes('for example'));
    expect(exampleLine).toBeDefined();
    const placeholders = exampleLine!.match(/⟦R\d:[0-9a-f]+⟧/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    for (const p of placeholders) {
      expect(p.startsWith('⟦R1:')).toBe(true);
    }
  });

  it('every ⟦ in the whole file has a matching ⟧ count', () => {
    const opens = (src.match(/⟦/g) ?? []).length;
    const closes = (src.match(/⟧/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
