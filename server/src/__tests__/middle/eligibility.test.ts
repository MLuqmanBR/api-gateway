import { describe, it, expect } from 'vitest';
import {
  shouldCompress,
  isCodeLine,
  isJsonContent,
  isYamlContent,
  extractCodeBlocks,
  extractUrls,
  extractHeadings,
  extractPaths,
  extractInlineCodes,
  validate,
  isValid,
} from '../../middle/compression/eligibility.js';

// ── Extension whitelist ────────────────────────────────────────────────────

describe('B1-3: shouldCompress (extension whitelist)', () => {
  it('accepts .md', () => {
    expect(shouldCompress('text', '', 'md')).toBe(true);
  });
  it('accepts .txt', () => {
    expect(shouldCompress('text', '', 'txt')).toBe(true);
  });
  it('accepts .markdown', () => {
    expect(shouldCompress('text', '', 'markdown')).toBe(true);
  });
  it('accepts .rst, .typ, .tex', () => {
    expect(shouldCompress('text', '', 'rst')).toBe(true);
    expect(shouldCompress('text', '', 'typ')).toBe(true);
    expect(shouldCompress('text', '', 'tex')).toBe(true);
  });
  it('rejects .py', () => {
    expect(shouldCompress('text', '', 'py')).toBe(false);
  });
  it('rejects .json', () => {
    expect(shouldCompress('text', '', 'json')).toBe(false);
  });
  it('rejects content-type application/json', () => {
    expect(shouldCompress('text', 'application/json', '')).toBe(false);
  });
  it('rejects content-type application/yaml', () => {
    expect(shouldCompress('text', 'application/yaml', '')).toBe(false);
  });
  it('allows when no extension or content-type specified', () => {
    expect(shouldCompress('text', '', '')).toBe(true);
  });
  it('rejects content > 500KB', () => {
    expect(shouldCompress('x'.repeat(524_289), '', 'md')).toBe(false);
  });
  it('accepts content exactly 500KB', () => {
    expect(shouldCompress('x'.repeat(524_288), '', 'md')).toBe(true);
  });
});

// ── Content gate predicates ────────────────────────────────────────────────

describe('B1-3: content gate predicates', () => {
  it('isCodeLine detects fenced code markers', () => {
    expect(isCodeLine('```python')).toBe(true);
    expect(isCodeLine('~~~bash')).toBe(true);
  });
  it('isCodeLine detects indented code', () => {
    expect(isCodeLine('    const x = 1;')).toBe(true);
    expect(isCodeLine('\tconst x = 1;')).toBe(true);
  });
  it('isCodeLine does not flag plain text', () => {
    expect(isCodeLine('hello world')).toBe(false);
  });
  it('isJsonContent detects JSON objects', () => {
    expect(isJsonContent('{"key": "value"}')).toBe(true);
  });
  it('isJsonContent detects JSON arrays', () => {
    expect(isJsonContent('[1, 2, 3]')).toBe(true);
  });
  it('isJsonContent rejects non-JSON', () => {
    expect(isJsonContent('hello world')).toBe(false);
  });
  it('isYamlContent detects YAML key: value', () => {
    expect(isYamlContent('name: test\nversion: 1\n---\n')).toBe(true);
  });
  it('isYamlContent rejects non-YAML', () => {
    expect(isYamlContent('just some plain text\nwith no colons')).toBe(false);
  });
});

// ── Extractors ──────────────────────────────────────────────────────────────

describe('B1-3: extractors', () => {
  it('extractCodeBlocks finds fenced blocks', () => {
    const text = 'before\n```js\nconst x = 1;\n```\nafter';
    expect(extractCodeBlocks(text)).toContain('const x = 1;');
  });
  it('extractCodeBlocks finds indented blocks', () => {
    const text = '    const y = 2;';
    expect(extractCodeBlocks(text).length).toBeGreaterThan(0);
  });
  it('extractUrls finds URLs', () => {
    const text = 'see https://example.com and http://test.io/path';
    expect(extractUrls(text)).toContain('https://example.com');
    expect(extractUrls(text)).toContain('http://test.io/path');
  });
  it('extractHeadings finds Markdown headings', () => {
    const text = '# Title\n## Subtitle\nbody';
    const headings = extractHeadings(text);
    expect(headings).toContain('# Title');
    expect(headings).toContain('## Subtitle');
  });
  it('extractPaths finds Unix paths', () => {
    const text = 'edit /etc/hosts and /usr/local/bin/node';
    const paths = extractPaths(text);
    expect(paths).toContain('/etc/hosts');
    expect(paths).toContain('/usr/local/bin/node');
  });
  it('extractInlineCodes finds backtick spans', () => {
    const text = 'use `npm test` and `npm run dev`';
    expect(extractInlineCodes(text)).toContain('npm test');
    expect(extractInlineCodes(text)).toContain('npm run dev');
  });
});

// ── Byte-exact validator ────────────────────────────────────────────────────

describe('B1-3: validate (byte-exact post-condition)', () => {
  it('returns valid for a no-op transform', () => {
    const text = '# Heading\n\nSome text with `code` and https://example.com and /path/to/file';
    const result = validate(text, text);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('detects changed code blocks', () => {
    const orig = '```js\nconst x = 1;\n```';
    const comp = '```js\nconst x = 2;\n```';
    expect(validate(orig, comp).valid).toBe(false);
    expect(validate(orig, comp).reasons).toContain('code blocks changed');
  });

  it('detects changed URLs', () => {
    const orig = 'see https://example.com';
    const comp = 'see https://different.com';
    expect(validate(orig, comp).valid).toBe(false);
    expect(validate(orig, comp).reasons).toContain('urls changed');
  });

  it('detects changed headings', () => {
    const orig = '# Title';
    const comp = '# Different';
    expect(validate(orig, comp).valid).toBe(false);
    expect(validate(orig, comp).reasons).toContain('headings changed');
  });

  it('detects changed inline codes', () => {
    const orig = 'use `npm test`';
    const comp = 'use `npm run dev`';
    expect(validate(orig, comp).valid).toBe(false);
    expect(validate(orig, comp).reasons).toContain('inline codes changed');
  });

  it('warns (not fails) on path mismatch in non-strict mode', () => {
    const orig = 'edit /etc/hosts';
    const comp = 'edit /etc/passwd';
    const result = validate(orig, comp);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('paths changed');
  });

  it('fails on path mismatch in strict mode', () => {
    const orig = 'edit /etc/hosts';
    const comp = 'edit /etc/passwd';
    const result = validate(orig, comp, { strict: true });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('paths changed');
  });

  it('isValid convenience returns boolean', () => {
    const text = '# Title with `code`';
    expect(isValid(text, text)).toBe(true);
    expect(isValid(text, text + '!')).toBe(false);
  });
});
