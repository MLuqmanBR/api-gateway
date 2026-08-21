// B1-1: Compression scaffold — config surface, master toggle, per-technique flags.
// No compression algorithm yet (B1-2 adds SmartCrusher; B1-4 wires it into applyOutbound).
//
// All settings default to OFF. When `middle_compression_enabled='0'` the
// entire compress step is short-circuited (§0 invariant #1 — disabled = not entered).

import { getSetting } from '../../db/index.js';
import { parseIntSetting, parseFloatSetting } from '../../lib/settings-parse.js';
import { compressStep, compressSafely, countTokensEstimate, emptyMetrics, type CompressionMetrics } from './metrics.js';

export { detectOffLimits, isJsonBlock, isOffLimitsRole, intersectsOffLimits, mustKeepMatches, mustKeepRe } from './protect.js';
export { compressStep, compressSafely, countTokensEstimate, emptyMetrics, type CompressionMetrics, type CompressResult } from './metrics.js';
export type { Span } from './protect.js';

// ── Compression config ─────────────────────────────────────────────────────

export interface CompressionConfig {
  enabled: boolean;
  protectRecent: number;
  smartCrusher: boolean;
  emitSentinel: boolean;
  smartCrusherLosslessOnly: boolean;
  minSavingsRatio: number;
}

let compConfigCache: { value: CompressionConfig; expires: number } | null = null;
const COMP_CONFIG_TTL_MS = 5000;

export function getCompressionConfig(): CompressionConfig {
  if (compConfigCache && Date.now() < compConfigCache.expires) {
    return compConfigCache.value;
  }
  const cfg: CompressionConfig = {
    enabled: getSetting('middle_compression_enabled') === '1',
    // M20: NaN-safe — corrupt values previously yielded NaN thresholds,
    // silently disabling the recency gate.
    protectRecent: parseIntSetting('middle_compression_protect_recent', 4),
    smartCrusher: getSetting('middle_compression_smart_crusher') === '1',
    emitSentinel: getSetting('middle_compression_emit_sentinel') === '1',
    smartCrusherLosslessOnly: getSetting('middle_compression_smart_crusher_lossless_only') === '1',
    minSavingsRatio: parseFloatSetting('middle_compression_min_savings_ratio', 0.15),
  };
  compConfigCache = { value: cfg, expires: Date.now() + COMP_CONFIG_TTL_MS };
  return cfg;
}

export function clearCompressionConfigCache(): void {
  compConfigCache = null;
}
