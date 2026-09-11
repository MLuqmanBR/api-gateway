/**
 * CommandCode model-catalog discovery.
 *
 * CommandCode has no OpenAI-compatible /models endpoint, so this module
 * scrapes the two pages that DO carry the authoritative catalog:
 *
 *  - https://commandcode.ai/docs/reference/cli/models — per-company tables
 *    with the dispatchable model IDs (`<code>company/model</code>`), display
 *    names, and a `Capabilities` cell whose aria-label spells out the
 *    capability set ("Text input, Vision, Reasoning").
 *  - https://commandcode.ai/models — the pricing/spec overview: context
 *    window, intelligence score, tok/s, input/output/cache-read/cache-write
 *    $/M prices, and the same capability label.
 *
 * The pages are statically generated tables with stable markup; both were
 * fetched and structure-verified live on 2026-09-11. The parser is
 * deliberately strict (parse-then-validate-then-return): any structural
 * drift throws instead of writing a partial catalog to the DB. Zero HTML
 * dependencies — regex over the table regions only.
 */

export interface CommandCodeCatalogRow {
  /** Dispatchable model ID exactly as the CLI registry spells it. Anthropic
   *  rows legitimately lack a company prefix ("claude-opus-5") — store
   *  verbatim, never guess a prefix. */
  modelId: string;
  displayName: string;
  slug: string;
  company: string;
  contextWindow: number | null;
  intelligenceScore: number | null;
  tokensPerSecond: number | null;
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  supportsVision: boolean;
  reasoning: boolean;
}

export const COMMANDCODE_CLI_MODELS_URL = 'https://commandcode.ai/docs/reference/cli/models';
export const COMMANDCODE_MODELS_URL = 'https://commandcode.ai/models';

export interface CliRow {
  /** Dispatchable model ID exactly as the CLI registry spells it. Anthropic
   *  rows legitimately lack a company prefix ("claude-opus-5") — store
   *  verbatim, never guess a prefix. */
  modelId: string;
  displayName: string;
  slug: string;
  company: string;
  capsLabel: string;
}

const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000; // polite to the site; auto-discover runs every 5 min
const MIN_EXPECTED_MODELS = 50;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+)?$/;
let cache: { at: number; rows: CommandCodeCatalogRow[] } | null = null;

/** Fetch + parse + merge + validate the full catalog. Cached for 10 minutes.
 *  Throws on any fetch/parse/validation failure — callers must treat a throw
 *  as "no writes happened". */
export async function fetchCommandCodeCatalog(): Promise<CommandCodeCatalogRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const [cliHtml, overviewHtml] = await Promise.all([
    fetchPage(COMMANDCODE_CLI_MODELS_URL),
    fetchPage(COMMANDCODE_MODELS_URL),
  ]);
  const cliRows = parseCommandCodeCliPage(cliHtml);
  const specs = parseCommandCodeOverviewPage(overviewHtml);
  const rows = validateCommandCodeCatalog(mergeCommandCodeCatalog(cliRows, specs));

  cache = { at: Date.now(), rows };
  return rows;
}

/** Test hook: drop the TTL cache. */
export function resetCommandCodeCatalogCache(): void {
  cache = null;
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CommandCode catalog page ${url} returned HTTP ${res.status}`);
  return res.text();
}

// ── CLI registry page ────────────────────────────────────────────────────

/** Parse the per-company tables on /docs/reference/cli/models. The `<code>`
 *  cell is the authoritative dispatchable ID; the Capabilities cell's
 *  aria-label is the official capability list. */
export function parseCommandCodeCliPage(html: string): CliRow[] {
  const sections = html.matchAll(
    /<h2 class="relative scroll-mt-24" id="([a-z0-9-]+)">([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2 |$)/g,
  );
  const rows: CliRow[] = [];
  for (const [, sectionId, h2Inner, body] of sections) {
    if (sectionId === 'next-steps') continue;
    const title = h2Inner.match(/<a[^>]*>([^<]*)<\/a>/);
    const company = decodeEntities(title?.[1]?.trim() || sectionId);
    for (const tr of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const row = tr[1];
      if (row.includes('<th>')) continue; // header row
      const code = row.match(/<code>([^<]*)<\/code>/);
      const link = row.match(/href="https:\/\/commandcode\.ai\/models\/([a-z0-9-]+)"/);
      const caps = row.match(/aria-label="Capabilities: ([^"]*)"/);
      if (!code || !link || !caps) {
        throw new Error(`CommandCode CLI models page: unparseable row in section "${sectionId}"`);
      }
      rows.push({
        modelId: decodeEntities(code[1]).trim(),
        displayName: rowDisplayName(row) ?? decodeEntities(code[1]).trim(),
        slug: link[1],
        company,
        capsLabel: decodeEntities(caps[1]),
      });
    }
  }
  if (rows.length === 0) {
    throw new Error('CommandCode CLI models page: no model rows found');
  }
  return rows;
}

/** Row display name = the first model-link's anchor text (the Name cell). */
function rowDisplayName(row: string): string | null {
  const name = row.match(/<a href="https:\/\/commandcode\.ai\/models\/[a-z0-9-]+"[^>]*>([^<]*)<\/a>/);
  return name ? decodeEntities(name[1]).trim() : null;
}

// ── Overview (pricing/spec) page ─────────────────────────────────────────

interface OverviewSpec {
  slug: string;
  contextWindow: number | null;
  intelligenceScore: number | null;
  tokensPerSecond: number | null;
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  capsLabel: string;
}

/** Parse the /models overview table: 9 cells per row —
 *  Model(slug link) / Context / Intelligence / Tok/s / Input / Output /
 *  Cache read / Cache write / Capabilities. */
export function parseCommandCodeOverviewPage(html: string): Map<string, OverviewSpec> {
  const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/);
  if (!table) throw new Error('CommandCode overview page: no <table> found');
  const tbody = table[0].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tbody) throw new Error('CommandCode overview page: no <tbody> found');

  const specs = new Map<string, OverviewSpec>();
  for (const tr of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
    if (cells.length !== 9) {
      throw new Error(`CommandCode overview page: expected 9 cells per row, got ${cells.length}`);
    }
    const slug = cells[0].match(/href="\/models\/([a-z0-9-]+)"/);
    if (!slug) throw new Error('CommandCode overview page: row without /models/<slug> link');
    if (specs.has(slug[1])) throw new Error(`CommandCode overview page: duplicate row for slug "${slug[1]}"`);
    const caps = cells[8].match(/aria-label="Capabilities: ([^"]*)"/);
    specs.set(slug[1], {
      slug: slug[1],
      contextWindow: parseContext(cellText(cells[1])),
      intelligenceScore: parseIntelligence(cellText(cells[2])),
      tokensPerSecond: parseIntOrDash(cellText(cells[3])),
      inputPerM: parseMoney(cellText(cells[4])),
      outputPerM: parseMoney(cellText(cells[5])),
      cacheReadPerM: parseMoney(cellText(cells[6])),
      cacheWritePerM: parseMoney(cellText(cells[7])),
      capsLabel: caps ? decodeEntities(caps[1]) : '',
    });
  }
  if (specs.size === 0) throw new Error('CommandCode overview page: no spec rows found');
  return specs;
}

/** Strip footnote-superscript buttons (their aria-labels carry off-peak
 *  detail we do not persist), struck-through old prices, and HTML comments;
 *  collapse to plain text. */
function cellText(cell: string): string {
  const cleaned = cell
    .replace(/<button[\s\S]*?<\/button>/g, ' ')
    .replace(/<s[\s\S]*?<\/s>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(cleaned).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** "1M" → 1048576, "500K" → 512000, "1.1M" → 1153434 (binary multipliers,
 *  matching the V32 seed conventions). */
function parseContext(raw: string): number | null {
  const m = raw.match(/^([\d.]+)([KM])$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'M' ? Math.round(n * 1048576) : Math.round(n * 1024);
}

function parseIntelligence(raw: string): number | null {
  if (/not yet scored/i.test(raw)) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrDash(raw: string): number | null {
  if (raw === '—' || raw === '-' || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** "$0.15" → 0.15; "Free" → 0; "—" → null. */
function parseMoney(raw: string): number | null {
  if (/^free$/i.test(raw)) return 0;
  if (raw === '—' || raw === '-' || raw === '') return null;
  const amounts = [...raw.matchAll(/\$([\d.]+)/g)];
  if (amounts.length === 0) return null;
  // After <s> stripping the current price is the only/last amount left.
  const n = Number.parseFloat(amounts[amounts.length - 1][1]);
  return Number.isFinite(n) ? n : null;
}

// ── Merge + validate ─────────────────────────────────────────────────────

/** Outer join weighted to the CLI page: every CLI-registry ID becomes a row;
 *  overview specs merge by slug; overview rows with no CLI ID are skipped
 *  (not dispatchable). */
export function mergeCommandCodeCatalog(cliRows: CliRow[], specs: Map<string, OverviewSpec>): CommandCodeCatalogRow[] {
  return cliRows.map(r => {
    const spec = specs.get(r.slug) ?? null;
    return {
      modelId: r.modelId,
      displayName: r.displayName,
      slug: r.slug,
      company: r.company,
      contextWindow: spec?.contextWindow ?? null,
      intelligenceScore: spec?.intelligenceScore ?? null,
      tokensPerSecond: spec?.tokensPerSecond ?? null,
      inputPerM: spec?.inputPerM ?? null,
      outputPerM: spec?.outputPerM ?? null,
      cacheReadPerM: spec?.cacheReadPerM ?? null,
      cacheWritePerM: spec?.cacheWritePerM ?? null,
      supportsVision: /Vision/.test(r.capsLabel) || /Vision/.test(spec?.capsLabel ?? ''),
      reasoning: /Reasoning/.test(r.capsLabel) || /Reasoning/.test(spec?.capsLabel ?? ''),
    };
  });
}

/** Hard validation before any consumer writes to the DB. Throws with a
 *  message naming the first violated expectation. */
export function validateCommandCodeCatalog(rows: CommandCodeCatalogRow[]): CommandCodeCatalogRow[] {
  if (rows.length < MIN_EXPECTED_MODELS) {
    throw new Error(`CommandCode catalog: only ${rows.length} models parsed (expected ≥ ${MIN_EXPECTED_MODELS})`);
  }
  const slugs = new Set<string>();
  for (const r of rows) {
    if (!MODEL_ID_PATTERN.test(r.modelId)) {
      throw new Error(`CommandCode catalog: malformed model ID "${r.modelId}"`);
    }
    if (!r.slug) throw new Error(`CommandCode catalog: row "${r.modelId}" has no slug`);
    if (slugs.has(r.slug)) throw new Error(`CommandCode catalog: duplicate slug "${r.slug}"`);
    slugs.add(r.slug);
    for (const [field, v] of [
      ['contextWindow', r.contextWindow],
      ['intelligenceScore', r.intelligenceScore],
      ['tokensPerSecond', r.tokensPerSecond],
      ['inputPerM', r.inputPerM],
      ['outputPerM', r.outputPerM],
      ['cacheReadPerM', r.cacheReadPerM],
      ['cacheWritePerM', r.cacheWritePerM],
    ] as const) {
      if (v !== null && !Number.isFinite(v)) {
        throw new Error(`CommandCode catalog: row "${r.modelId}" field ${field} is not numeric-or-null`);
      }
    }
  }
  return rows;
}
