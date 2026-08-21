// B1-3: Eligibility detector + byte-exact validator (caveman-compress safety scaffold).
// Adapted from caveman-compress (Julius Brussee, MIT) — concept port, not code-copy.
// Shipped now as tested infra; meaningful for future text-compressor rows beyond SmartCrusher.

const MAX_CONTENT_BYTES = 512 * 1024; // 512 KiB — refuse to compress single content strings above this.

// ── Extension whitelist ────────────────────────────────────────────────────
const COMPRESSIBLE_EXTENSIONS = new Set(['md', 'txt', 'markdown', 'rst', 'typ', 'tex']);
const NON_COMPRESSIBLE_CONTENT_TYPES = new Set([
  'application/json', 'application/yaml', 'application/x-yaml',
  'text/yaml', 'text/x-yaml',
  'application/javascript', 'text/javascript',
  'application/x-python', 'text/x-python',
  'text/html', 'application/xml',
]);

/** Determine whether content should be compressed based on extension/content-type. */
export function shouldCompress(contentText: string, contentType: string = '', extension: string = ''): boolean {
  // Max-file gate
  // M35: measure BYTES, not UTF-16 code units — `.length` undercounts
  // multi-byte content (CJK, emoji), letting oversized payloads through.
  if (Buffer.byteLength(contentText, 'utf8') > MAX_CONTENT_BYTES) return false;
  // Extension whitelist
  const ext = extension.replace(/^\./, '').toLowerCase();
  if (ext && COMPRESSIBLE_EXTENSIONS.has(ext)) return true;
  if (ext && !COMPRESSIBLE_EXTENSIONS.has(ext)) return false;
  // Content-type reject
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct && NON_COMPRESSIBLE_CONTENT_TYPES.has(ct)) return false;
  // Default: allow (no extension/content-type specified)
  return true;
}

// ── Content gate predicates ──────────────────────────────────────────────────

export function isCodeLine(line: string): boolean {
  // Indented code block (4+ spaces or tab) or fenced code marker
  return /^( {4,}|\t)/.test(line) || /^\s*(`{3,}|~{3,})/.test(line);
}

export function isJsonContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

export function isYamlContent(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) return false;
  // YAML: key: value pattern (space after the colon optional — compact
  // `key:value` is valid YAML), document separator, or list items (- )
  const yamlLinePattern = /^(\s*[\w-]+:\s?|---\s*$|\s*-\s)/;
  let yamlLines = 0;
  for (const line of lines) {
    if (yamlLinePattern.test(line)) yamlLines++;
  }
  return yamlLines / lines.length >= 0.6;
}

// ── Extractors (for byte-exact validation) ───────────────────────────────────

export function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  // Fenced code blocks
  const fenceRe = /((`{3,}|~{3,})[^\n]*\n)([\s\S]*?)\n\2/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) blocks.push(m[3]);
  // Indented code blocks (4+ spaces or tab)
  const indentedRe = /^( {4,}|\t).+$/gm;
  const indented: string[] = [];
  let im: RegExpExecArray | null;
  while ((im = indentedRe.exec(text)) !== null) indented.push(im[0]);
  if (indented.length > 0) blocks.push(indented.join('\n'));
  return blocks;
}

export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s)]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) urls.push(m[0]);
  return urls;
}

export function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) headings.push(`${m[1]} ${m[2]}`);
  return headings;
}

export function extractPaths(text: string): string[] {
  const paths: string[] = [];
  const re = /(?:^|\s)(\/(?:[^\s/]+\/)*[^\s/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) paths.push(m[1]);
  return paths;
}

export function extractInlineCodes(text: string): string[] {
  const codes: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) codes.push(m[1]);
  return codes;
}

// ── Byte-exact post-condition validator ────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  warnings: string[];
}

export interface ValidateOptions {
  strict?: boolean; // path mismatch is fatal when true
}

/** Validate that a transform preserves code blocks, URLs, headings, paths, inline codes. */
export function validate(orig: string, comp: string, opts: ValidateOptions = {}): ValidationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const strict = opts.strict ?? false;

  const origCodeBlocks = extractCodeBlocks(orig);
  const compCodeBlocks = extractCodeBlocks(comp);
  if (JSON.stringify(origCodeBlocks) !== JSON.stringify(compCodeBlocks)) {
    reasons.push('code blocks changed');
  }

  const origUrls = extractUrls(orig);
  const compUrls = extractUrls(comp);
  if (JSON.stringify(origUrls) !== JSON.stringify(compUrls)) {
    reasons.push('urls changed');
  }

  const origHeadings = extractHeadings(orig);
  const compHeadings = extractHeadings(comp);
  if (JSON.stringify(origHeadings) !== JSON.stringify(compHeadings)) {
    reasons.push('headings changed');
  }

  const origPaths = extractPaths(orig);
  const compPaths = extractPaths(comp);
  if (JSON.stringify(origPaths) !== JSON.stringify(compPaths)) {
    if (strict) reasons.push('paths changed');
    else warnings.push('paths changed');
  }

  const origCodes = extractInlineCodes(orig);
  const compCodes = extractInlineCodes(comp);
  if (JSON.stringify(origCodes) !== JSON.stringify(compCodes)) {
    reasons.push('inline codes changed');
  }

  return { valid: reasons.length === 0, reasons, warnings };
}

/** Convenience: returns true if valid, false if any byte-exact check fails. */
export function isValid(orig: string, comp: string, opts?: ValidateOptions): boolean {
  return validate(orig, comp, opts).valid;
}
