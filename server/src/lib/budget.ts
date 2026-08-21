// Monthly free-tier budgets are stored as human labels like '~120M', '~50-100M',
// '~12M', or '~500K'. Parse the upper bound to an absolute token count for
// quota math (headroom guardrail, token-usage bar). Returns 0 for unknown/empty
// labels, which callers treat as "no budget info".
export function parseBudget(s: string): number {
  if (!s) return 0;
  // N33: `[\d.]+` matched "12.5.3" as "12.5" (prefix bite) — require a
  // well-formed number so malformed labels parse as 0 ("no budget info").
  const m = s.match(/~?(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?([MK])?/);
  if (!m) return 0;
  const high = parseFloat(m[2] ?? m[1]);
  if (Number.isNaN(high)) return 0;
  const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
  return high * unit;
}
