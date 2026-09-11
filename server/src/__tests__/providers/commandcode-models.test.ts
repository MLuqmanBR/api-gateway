import { describe, it, expect } from 'vitest';
import {
  parseCommandCodeCliPage,
  parseCommandCodeOverviewPage,
  mergeCommandCodeCatalog,
  validateCommandCodeCatalog,
} from '../../providers/commandcode-models.js';

// Fixtures replicate the real markup of commandcode.ai (structure-verified
// live 2026-09-11): h2 sections with per-company tables, `<code>` IDs,
// capability aria-labels; overview table with 9 cells per row.

const GLYPH_SVG = '<svg class="size-4" viewBox="0 0 24 24"><path d="M13 2.5H4.5V21.5H19.5V9L13 2.5Z"></path></svg>';

function cliRow(id: string, slug: string, name: string, caps: string): string {
  return `<tr><td><span class="inline-flex items-center gap-1 whitespace-nowrap">` +
    `<a href="https://commandcode.ai/models/${slug}" target="_blank" rel="noopener noreferrer" class="text-burple-foreground"><code>${id}</code></a>` +
    `<button aria-label="Copy ${id}"><svg class="w-4"></svg></button></span></td>` +
    `<td><a href="https://commandcode.ai/models/${slug}" target="_blank" rel="noopener noreferrer" class="text-burple-foreground">${name}</a></td>` +
    `<td><button type="button" aria-label="Capabilities: ${caps}" data-state="closed">${GLYPH_SVG}</button></td>` +
    `<td>best for stuff</td></tr>`;
}

function cliPage(...sections: Array<{ id: string; title: string; rows: string[] }>): string {
  return sections.map(s =>
    `<h2 class="relative scroll-mt-24" id="${s.id}"><div class="flex justify-between"><span class="group">` +
    `<a class="text-inherit no-underline hover:text-inherit" href="#${s.id}">${s.title}</a></span></div></h2>` +
    `<div class="relative max-w-full overflow-x-auto"><table class="whitespace-nowrap"><thead><tr>` +
    `<th>Model ID</th><th>Name</th><th>Capabilities</th><th>Best for</th></tr></thead><tbody>` +
    s.rows.join('') + `</tbody></table></div>`
  ).join('') +
  `<h2 class="relative scroll-mt-24" id="next-steps"><div class="flex justify-between"><span class="group"><a class="text-inherit" href="#next-steps">Next steps</a></span></div></h2><p>Go use it.</p>`;
}

function specRow(
  slug: string,
  name: string,
  context: string,
  intelligence: string,
  toks: string,
  input: string,
  output: string,
  cacheRead: string,
  cacheWrite: string,
  caps: string,
): string {
  const footnote = (label: string) =>
    `<button type="button" aria-label="${label}" aria-expanded="false" data-state="closed">+<!-- -->1</button>`;
  const price = (raw: string, label: string) =>
    raw === '—' ? `<td><span class="block leading-5 text-muted-foreground/50">—</span></td>`
      : `<td><span class="block leading-5 whitespace-nowrap text-white">${raw}${footnote(label)}</span></td>`;
  return `<tr><td><div class="max-w-[10rem] md:max-w-none"><span class="flex min-w-0 items-center gap-2">` +
    `<a class="flex min-w-0 items-center gap-2" href="/models/${slug}" data-discover="true"><span class="truncate text-white group-hover:underline">${name}</span></a>` +
    `</span></div></td>` +
    `<td><span class="block leading-5">${context}</span></td>` +
    `<td><span class="block text-right font-mono text-[11px]">${intelligence}</span></td>` +
    `<td><span class="block leading-5">${toks}</span></td>` +
    price(input, `${name} input: peak pricing applies`) +
    price(output, `${name} output: peak pricing applies`) +
    price(cacheRead, `${name} cache read: peak pricing applies`) +
    price(cacheWrite, `${name} cache write: peak pricing applies`) +
    `<td><button type="button" aria-label="Capabilities: ${caps}" data-state="closed">${GLYPH_SVG}</button></td></tr>`;
}

function overviewPage(rows: string[]): string {
  return `<main><table><thead><tr><th>Model</th><th>Context</th><th>Intelligence</th><th>Tok/s</th>` +
    `<th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Caps</th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table></main>`;
}

describe('CommandCode catalog scraper', () => {
  const cliHtml = cliPage(
    {
      id: 'deep-seek',
      title: 'DeepSeek',
      rows: [
        cliRow('deepseek/deepseek-v4.1-flash', 'deepseek-v4-1-flash', 'DeepSeek V4.1 Flash', 'Text input, Vision, Reasoning'),
        cliRow('deepseek/deepseek-v4-flash', 'deepseek-v4-flash', 'DeepSeek V4 Flash (latest)', 'Text input, Reasoning'),
      ],
    },
    {
      id: 'anthropic',
      title: 'Anthropic',
      rows: [cliRow('claude-opus-5', 'claude-opus-5', 'Claude Opus 5', 'Text input, Vision, Reasoning')],
    },
  );

  const overviewHtml = overviewPage([
    // current price has a struck-through old price; all four prices have footnote buttons
    specRow('deepseek-v4-1-flash', 'DeepSeek V4.1 Flash', '1M', 'not yet scored', '—', '$0.15', '$0.60', '$0.003', '—', 'Text input, Vision, Reasoning'),
    // context with decimal multiplier; intelligence scored; cache write Free
    specRow('deepseek-v4-flash', 'DeepSeek V4 Flash (latest)', '1.1M', '41', '118', '$0.15', '$0.60', '$0.003', 'Free', 'Text input, Reasoning'),
    // strikethrough old price ($0.60 struck, $0.30 current)
    `<tr><td><div><span><a href="/models/minimax-m3"><span>MiniMax M3</span></a></span></div></td>` +
      `<td><span>200K</span></td><td><span>52.3</span></td><td><span>89</span></td>` +
      `<td><span class="whitespace-nowrap"><s class="mr-1 text-[10px]">$0.60</s>$0.30<button aria-label="MiniMax M3: 2 context price bands">+<!-- -->1</button></span></td>` +
      `<td><span>$1.20</span></td><td><span>—</span></td><td><span>—</span></td>` +
      `<td><button aria-label="Capabilities: Text input, Reasoning">${GLYPH_SVG}</button></td></tr>`,
    // overview row with NO CLI registry entry — must be skipped in the merge
    specRow('unregistered-model', 'Unregistered Model', '500K', '10', '50', 'Free', 'Free', '—', '—', 'Text input'),
  ]);

  it('parses CLI registry rows: id verbatim (incl. unprefixed), name, company, caps', () => {
    const rows = parseCommandCodeCliPage(cliHtml);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({
      modelId: 'deepseek/deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      slug: 'deepseek-v4-1-flash',
      company: 'DeepSeek',
    });
    // Anthropic rows legitimately have no company prefix — stored verbatim
    expect(rows[2].modelId).toBe('claude-opus-5');
    expect(rows[2].company).toBe('Anthropic');
    expect(rows[0].capsLabel).toBe('Text input, Vision, Reasoning');
  });

  it('throws on a structurally broken CLI page instead of guessing', () => {
    expect(() => parseCommandCodeCliPage('<h2 class="relative scroll-mt-24" id="deep-seek"><a>DeepSeek</a></h2><table><tr><td>garbage</td></tr></table>')).toThrow(/unparseable row/);
    expect(() => parseCommandCodeCliPage('<p>nothing here</p>')).toThrow(/no model rows/);
  });

  it('parses overview specs: context multipliers, prices, dashes, Free, not-yet-scored', () => {
    const specs = parseCommandCodeOverviewPage(overviewHtml);
    expect(specs.size).toBe(4);
    const v41 = specs.get('deepseek-v4-1-flash')!;
    expect(v41.contextWindow).toBe(1048576);
    expect(v41.intelligenceScore).toBeNull();
    expect(v41.tokensPerSecond).toBeNull();
    expect(v41.inputPerM).toBe(0.15);
    expect(v41.outputPerM).toBe(0.6);
    expect(v41.cacheReadPerM).toBe(0.003);
    expect(v41.cacheWritePerM).toBeNull(); // — → null

    const v4 = specs.get('deepseek-v4-flash')!;
    expect(v4.contextWindow).toBe(1153434); // 1.1M binary
    expect(v4.intelligenceScore).toBe(41);
    expect(v4.tokensPerSecond).toBe(118);
    expect(v4.cacheWritePerM).toBe(0); // Free → 0

    const m3 = specs.get('minimax-m3')!;
    expect(m3.contextWindow).toBe(204800); // 200K binary
    expect(m3.inputPerM).toBe(0.30); // struck-through $0.60 ignored, footnote button stripped
  });

  it('merges CLI ids with overview specs by slug and skips unregistered overview rows', () => {
    const cli = parseCommandCodeCliPage(cliHtml);
    const specs = parseCommandCodeOverviewPage(overviewHtml);
    const rows = mergeCommandCodeCatalog(cli, specs);
    expect(rows.length).toBe(3); // unregistered-model skipped

    const v41 = rows.find(r => r.modelId === 'deepseek/deepseek-v4.1-flash')!;
    expect(v41.supportsVision).toBe(true);
    expect(v41.reasoning).toBe(true);

    const v4 = rows.find(r => r.modelId === 'deepseek/deepseek-v4-flash')!;
    expect(v4.supportsVision).toBe(false);
    expect(v4.reasoning).toBe(true);
  });

  it('tolerates a CLI id with no overview row (null specs)', () => {
    const cli = parseCommandCodeCliPage(cliPage(
      { id: 'acme', title: 'Acme', rows: [cliRow('acme/new-model', 'new-model', 'New Model', 'Text input')] },
    ));
    const rows = mergeCommandCodeCatalog(cli, new Map());
    expect(rows.length).toBe(1);
    expect(rows[0].contextWindow).toBeNull();
    expect(rows[0].inputPerM).toBeNull();
    expect(rows[0].supportsVision).toBe(false);
    expect(rows[0].reasoning).toBe(false);
  });

  it('validates: row-count floor, id format, duplicate slugs, numeric-or-null', () => {
    const cli = parseCommandCodeCliPage(cliHtml);
    const specs = parseCommandCodeOverviewPage(overviewHtml);
    const rows = mergeCommandCodeCatalog(cli, specs);
    // 3 rows < floor of 50
    expect(() => validateCommandCodeCatalog(rows)).toThrow(/only 3 models/);

    // pad to the floor with generated rows so later assertions are reachable
    const padded = [
      ...rows,
      ...Array.from({ length: 50 }, (_, i) => ({
        modelId: `acme/model-${i}`,
        displayName: `Model ${i}`,
        slug: `model-${i}`,
        company: 'Acme',
        contextWindow: 1048576,
        intelligenceScore: 40,
        tokensPerSecond: 100,
        inputPerM: 0.1,
        outputPerM: 0.2,
        cacheReadPerM: 0.01,
        cacheWritePerM: null,
        supportsVision: false,
        reasoning: true,
      })),
    ];
    expect(validateCommandCodeCatalog(padded).length).toBe(53);

    const badId = padded.map(r => ({ ...r }));
    badId[0] = { ...badId[0], modelId: 'bad id with spaces' };
    expect(() => validateCommandCodeCatalog(badId)).toThrow(/malformed model ID/);

    const dupSlug = padded.map(r => ({ ...r }));
    dupSlug[1] = { ...dupSlug[1], slug: dupSlug[0].slug };
    expect(() => validateCommandCodeCatalog(dupSlug)).toThrow(/duplicate slug/);

    const nanPrice = padded.map(r => ({ ...r }));
    nanPrice[2] = { ...nanPrice[2], inputPerM: Number.NaN };
    expect(() => validateCommandCodeCatalog(nanPrice)).toThrow(/not numeric-or-null/);
  });
});
