// B1-2: SmartCrusher — JSON-array drop technique + TOON [N]{cols} lossless variant.
// Adapted from headroom (Headroom Contributors, Apache-2.0) SmartCrusher — concept port,
// not code-copy. The reference is Rust+Python; this is original TS.

import { detectOffLimits, mustKeepMatches, intersectsOffLimits } from '../protect.js';
import { countTokensEstimate } from '../metrics.js';

// ── Error keywords (curated TS list, same intent as headroom error_keywords.rs) ──
const ERROR_KEYWORDS = ['error', 'fail', 'exception', 'panic', 'fatal', 'traceback', 'stderr'];

// ── Types ────────────────────────────────────────────────────────────────────

export type ArrayShape = 'dict-array' | 'string-array' | 'number-array' | 'object' | 'mixed' | 'scalar';

export interface SmartCrushOptions {
  queryTokens?: string[];
  losslessOnly?: boolean;
  emitSentinel?: boolean;
  minSavingsRatio?: number; // default 0.15 (85% kept → passthrough)
}

export interface SmartCrushResult {
  output: string;
  sentinel: string | null;
  applied: boolean;
  originalCount: number;
  keptCount: number;
  droppedCount: number;
  shape: ArrayShape;
}

// ── Shape detection ─────────────────────────────────────────────────────────

export function detectShape(arr: unknown[]): ArrayShape {
  if (!Array.isArray(arr) || arr.length === 0) return 'scalar';
  const first = arr[0];
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    // Check if ALL elements are objects (dict-array)
    const dictFraction = arr.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x)).length / arr.length;
    if (dictFraction >= 0.5) return 'dict-array';
    return 'mixed';
  }
  if (typeof first === 'string') {
    const strFraction = arr.filter(x => typeof x === 'string').length / arr.length;
    if (strFraction >= 0.8) return 'string-array';
    return 'mixed';
  }
  if (typeof first === 'number') {
    const numFraction = arr.filter(x => typeof x === 'number').length / arr.length;
    if (numFraction >= 0.8) return 'number-array';
    return 'mixed';
  }
  return 'mixed';
}

// ── SimHash (64-bit rolling hash for near-duplicate detection) ──────────────

function hashStr(str: string): number {
  let h = 0xcbf29ce484222325n; // FNV offset
  for (let i = 0; i < str.length; i++) {
    h = BigInt.asUintN(64, h ^ BigInt(str.charCodeAt(i)));
    h = BigInt.asUintN(64, h * 0x100000001b3n); // FNV prime
  }
  return Number(BigInt.asUintN(64, h));
}

export function simHash(str: string): number {
  const tokens = str.toLowerCase().split(/\s+/).filter(Boolean);
  const v = new Int8Array(64);
  for (const tok of tokens) {
    const h = hashStr(tok);
    for (let i = 0; i < 64; i++) {
      if ((h >> i) & 1) v[i]++; else v[i]--;
    }
  }
  let result = 0;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) result |= (1 << i);
  }
  return result >>> 0; // unsigned
}

function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let d = 0;
  while (x) { d += x & 1; x >>>= 1; }
  return d;
}

// ── Adaptive K (Kneedle-style — target-row-count from array length + savings) ─

export function pickK(arrLength: number): number {
  // Larger arrays → more aggressive compression. Target: keep ~40% of rows,
  // bounded by a minimum of 5 and a maximum of the array length.
  if (arrLength <= 5) return arrLength;
  const target = Math.ceil(arrLength * 0.4);
  return Math.max(5, target);
}

export function splitK(k: number): { kFirst: number; kLast: number } {
  const kFirst = Math.max(1, Math.ceil(k * 0.3));
  const kLast = Math.max(1, Math.ceil(k * 0.15));
  return { kFirst, kLast };
}

// ── Always-keep constraints ────────────────────────────────────────────────

function rowHasError(row: unknown): boolean {
  const s = JSON.stringify(row).toLowerCase();
  return ERROR_KEYWORDS.some(kw => s.includes(kw));
}

function rowHasQueryMatch(row: unknown, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return false;
  const s = JSON.stringify(row).toLowerCase();
  return queryTokens.some(tok => s.includes(tok.toLowerCase()));
}

function rowHasMustKeep(row: unknown): boolean {
  const s = JSON.stringify(row);
  const mustKeeps = mustKeepMatches(s);
  return mustKeeps.length > 0;
}

/** Return indices of rows that MUST be kept (error rows, query matches, mustKeep tokens). */
export function keepConstraints(arr: unknown[], queryTokens: string[] = []): Set<number> {
  const keep = new Set<number>();
  const lengths = arr.map(x => JSON.stringify(x).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const std = Math.sqrt(lengths.map(l => (l - mean) ** 2).reduce((a, b) => a + b, 0) / lengths.length);

  for (let i = 0; i < arr.length; i++) {
    if (rowHasError(arr[i]) || rowHasQueryMatch(arr[i], queryTokens) || rowHasMustKeep(arr[i])) {
      keep.add(i);
    }
    // Length-anomaly rows (z-score > 2)
    if (std > 0 && Math.abs(lengths[i] - mean) / std > 2) {
      keep.add(i);
    }
  }
  return keep;
}

// ── Strided fill with SimHash dedup ──────────────────────────────────────────

function fillRemaining(
  arr: unknown[],
  keep: Set<number>,
  k: number,
): number[] {
  const { kFirst, kLast } = splitK(k);
  const result: number[] = [];
  const seen = new Set<number>();
  const hashes: number[] = [];

  // Always-keep indices are ALWAYS included, even if they exceed K.
  // (error rows, query-anchor matches, mustKeep tokens — hard constraints)
  for (const idx of keep) {
    result.push(idx);
    seen.add(idx);
    hashes.push(simHash(JSON.stringify(arr[idx])));
  }

  // Head budget — fill from the front up to kFirst (if not already covered)
  for (let i = 0; i < arr.length && result.filter(x => x < kFirst).length < kFirst; i++) {
    if (seen.has(i)) continue;
    result.push(i);
    seen.add(i);
    hashes.push(simHash(JSON.stringify(arr[i])));
  }

  // Tail budget — fill from the back up to kLast
  for (let i = arr.length - 1; i >= 0 && result.filter(x => x > arr.length - 1 - kLast).length < kLast; i--) {
    if (seen.has(i)) continue;
    result.push(i);
    seen.add(i);
    hashes.push(simHash(JSON.stringify(arr[i])));
  }

  // Strided fill of remaining slots up to K, deduped by SimHash (Hamming ≤ 3 = near-dup)
  const remaining = Math.max(0, k - result.length);
  if (remaining > 0) {
    const stride = Math.max(1, Math.floor(arr.length / remaining));
    for (let i = 0; i < arr.length && result.length < k; i += stride) {
      if (seen.has(i)) continue;
      const h = simHash(JSON.stringify(arr[i]));
      let isDup = false;
      for (const eh of hashes) {
        if (hammingDistance(h, eh) <= 3) { isDup = true; break; }
      }
      if (isDup) continue;
      result.push(i);
      seen.add(i);
      hashes.push(h);
    }
  }

  // Sort to preserve original order (output is a strict subset of input indices)
  return result.sort((a, b) => a - b);
}

// ── TOON [N]{cols} lossless CSV-schema render ───────────────────────────────

function csvEscape(val: string): string {
  if (val.includes('"') || val.includes(',') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function toonRender(arr: Record<string, unknown>[]): string {
  if (arr.length === 0) return '[]';
  const cols = Object.keys(arr[0]);
  const header = `[${arr.length}]{${cols.join(',')}}`;
  const csvHeader = cols.map(csvEscape).join(',');
  const csvRows = arr.map(row =>
    cols.map(c => csvEscape(String(row[c] ?? ''))).join(',')
  );
  return [header, csvHeader, ...csvRows].join('\n');
}

// ── Sentinel marker ──────────────────────────────────────────────────────────

function makeSentinel(droppedCount: number, hash: string): string {
  return `⟦C7:<<crushed ${droppedCount} rows, hash ${hash}>>⟧`;
}

function clusterDigest(arr: unknown[]): string {
  const s = JSON.stringify(arr);
  // Simple 6-hex-char digest from a FNV hash of the array
  const h = hashStr(s);
  return (h >>> 0).toString(16).padStart(6, '0').slice(0, 6);
}

// ── SmartCrusher main entry ──────────────────────────────────────────────────

export function smartCrush(content: string, opts: SmartCrushOptions = {}): SmartCrushResult {
  const losslessOnly = opts.losslessOnly ?? true;
  const emitSentinel = opts.emitSentinel ?? true;
  const minSavingsRatio = opts.minSavingsRatio ?? 0.15;

  // Parse JSON. If parse fails → passthrough.
  let arr: unknown;
  try {
    arr = JSON.parse(content);
  } catch {
    return { output: content, sentinel: null, applied: false, originalCount: 0, keptCount: 0, droppedCount: 0, shape: 'scalar' };
  }

  if (!Array.isArray(arr)) {
    return { output: content, sentinel: null, applied: false, originalCount: 0, keptCount: 0, droppedCount: 0, shape: 'object' };
  }

  const shape = detectShape(arr);
  if (shape !== 'dict-array' && shape !== 'string-array' && shape !== 'number-array') {
    return { output: content, sentinel: null, applied: false, originalCount: arr.length, keptCount: arr.length, droppedCount: 0, shape };
  }

  const originalCount = arr.length;

  // ── TOON lossless render (applies to dict-array only) ─────────────────────
  if (shape === 'dict-array' && losslessOnly) {
    const toon = toonRender(arr as Record<string, unknown>[]);
    const originalTokens = countTokensEstimate(content);
    const toonTokens = countTokensEstimate(toon);
    if (toonTokens < originalTokens) {
      return { output: toon, sentinel: null, applied: true, originalCount, keptCount: originalCount, droppedCount: 0, shape };
    }
    return { output: content, sentinel: null, applied: false, originalCount, keptCount: originalCount, droppedCount: 0, shape };
  }

  // ── Lossy row-drop (SmartCrusher) ─────────────────────────────────────────
  const k = pickK(arr.length);
  const keep = keepConstraints(arr, opts.queryTokens);
  const indices = fillRemaining(arr, keep, k);

  // Min-savings floor: if kept ≥ 85% of original → passthrough
  const keptFraction = indices.length / arr.length;
  if (1 - keptFraction < minSavingsRatio) {
    return { output: content, sentinel: null, applied: false, originalCount, keptCount: arr.length, droppedCount: 0, shape };
  }

  const subset = indices.map(i => arr[i]);
  const droppedCount = arr.length - subset.length;

  // If nothing was dropped, no compression happened
  if (droppedCount === 0) {
    return { output: content, sentinel: null, applied: false, originalCount, keptCount: arr.length, droppedCount: 0, shape };
  }

  // Check off-limits spans in the compressed content — if a placeholder is inside
  // a dropped row, abort (the placeholder would be lost).
  const offLimits = detectOffLimits(content);
  for (const idx of [...arr.keys()]) {
    if (!indices.includes(idx)) {
      // This row was dropped — check if it contained off-limits content
      const rowStr = JSON.stringify(arr[idx]);
      const rowStart = content.indexOf(rowStr);
      if (rowStart >= 0 && intersectsOffLimits(rowStart, rowStart + rowStr.length, offLimits)) {
        // Off-limits content in a dropped row — abort, return original
        return { output: content, sentinel: null, applied: false, originalCount, keptCount: arr.length, droppedCount: 0, shape };
      }
    }
  }

  // For dict-array, use TOON render on the subset; otherwise JSON.stringify
  let output: string;
  if (shape === 'dict-array') {
    output = toonRender(subset as Record<string, unknown>[]);
  } else {
    output = JSON.stringify(subset);
  }

  // Inflation guard
  const originalTokens = countTokensEstimate(content);
  const compressedTokens = countTokensEstimate(output);
  if (compressedTokens >= originalTokens) {
    return { output: content, sentinel: null, applied: false, originalCount, keptCount: arr.length, droppedCount: 0, shape };
  }

  const sentinel = emitSentinel && droppedCount > 0
    ? makeSentinel(droppedCount, clusterDigest(arr))
    : null;

  return {
    output,
    sentinel,
    applied: true,
    originalCount,
    keptCount: subset.length,
    droppedCount,
    shape,
  };
}
