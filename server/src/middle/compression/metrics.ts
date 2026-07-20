// B1-1: Savings meter + inflation guard + fail-open exception guard.
// Mirrors headroom compress.py:265-278 (inflation guard) + compress.py:336-349 (fail-open).

/** Token estimate via the existing char/4 heuristic (consistent with proxy.ts).
 * Do NOT import tiktoken — adds a native dep against the minimal-diff posture. */
export function countTokensEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Result of a compression step. */
export type CompressResult = {
  out: string;
  saved: number;
  applied: boolean;
};

/** Returns the compressed string ONLY if it is a strict saving and never an inflation.
 * Mirrors headroom compress.py:265-278 inflation guard (verified). */
export function compressStep(original: string, compressed: string): CompressResult {
  const before = countTokensEstimate(original);
  const after = countTokensEstimate(compressed);
  if (after >= before) return { out: original, saved: 0, applied: false }; // inflation guard
  return { out: compressed, saved: before - after, applied: true };
}

/** Fail-open wrapper: if the compressor throws, return the original unchanged.
 * Mirrors headroom compress.py:336-349. */
export function compressSafely<T>(original: T, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    console.error('[middle] compressor failed open:', (e as Error).message);
    return original;
  }
}

/** Running metrics for a middle-layer session. */
export type CompressionMetrics = {
  compressionApplied: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  inflationsReverted: number;
  failuresOpened: number;
};

export function emptyMetrics(): CompressionMetrics {
  return {
    compressionApplied: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    inflationsReverted: 0,
    failuresOpened: 0,
  };
}

/** Record a compression step result into the metrics. */
export function recordStep(metrics: CompressionMetrics, result: CompressResult, originalTokens: number): void {
  metrics.tokensBefore += originalTokens;
  if (result.applied) {
    metrics.compressionApplied++;
    metrics.tokensAfter += countTokensEstimate(result.out);
    metrics.tokensSaved += result.saved;
  } else {
    metrics.tokensAfter += originalTokens;
    if (countTokensEstimate(result.out) >= originalTokens) metrics.inflationsReverted++;
  }
}
