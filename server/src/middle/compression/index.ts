// B1-1: Compression scaffold — config surface, master toggle, per-technique flags.
// No compression algorithm yet (B1-2 adds SmartCrusher; B1-4 wires it into applyOutbound).
//
// All settings default to OFF. When `middle_compression_enabled='0'` the
// entire compress step is short-circuited (§0 invariant #1 — disabled = not entered).

import type { ChatMessage } from '@api-gateway/shared';
import { getSetting } from '../../db/index.js';
import { compressStep, compressSafely, countTokensEstimate, emptyMetrics, type CompressionMetrics } from './metrics.js';

export { detectOffLimits, isJsonBlock, isOffLimitsRole, intersectsOffLimits, mustKeepMatches, mustKeepRe } from './protect.js';
export { compressStep, compressSafely, countTokensEstimate, emptyMetrics, type CompressionMetrics, type CompressResult } from './metrics.js';
export type { Span } from './protect.js';

// ── Compression config ─────────────────────────────────────────────────────

export interface CompressionConfig {
  enabled: boolean;
  minTokens: number;
  protectRecent: number;
  smartCrusher: boolean;
  toon: boolean;
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
    minTokens: parseInt(getSetting('middle_compression_min_tokens') ?? '250', 10),
    protectRecent: parseInt(getSetting('middle_compression_protect_recent') ?? '4', 10),
    smartCrusher: getSetting('middle_compression_smart_crusher') === '1',
    toon: getSetting('middle_compression_toon') === '1',
    emitSentinel: getSetting('middle_compression_emit_sentinel') === '1',
    smartCrusherLosslessOnly: getSetting('middle_compression_smart_crusher_lossless_only') === '1',
    minSavingsRatio: parseFloat(getSetting('middle_compression_min_savings_ratio') ?? '0.15'),
  };
  compConfigCache = { value: cfg, expires: Date.now() + COMP_CONFIG_TTL_MS };
  return cfg;
}

export function clearCompressionConfigCache(): void {
  compConfigCache = null;
}

// ── Compress step (stub — B1-2 adds SmartCrusher, B1-4 wires it) ────────────

/**
 * Compress the outbound message array. B1-1 scaffold: no algorithm yet.
 * Returns the original array unchanged with zeroed metrics.
 * B1-4 will iterate messages, apply SmartCrusher to eligible role:"tool"
 * content, and insert sentinel system messages after compressed tool outputs.
 */
export function compressMessages(
  messages: ChatMessage[],
  metrics: CompressionMetrics,
): ChatMessage[] {
  const cfg = getCompressionConfig();
  if (!cfg.enabled) return messages;

  // B1-1: scaffold only — no technique implemented.
  // B1-2 will add SmartCrusher; B1-4 will wire it here.
  return messages;
}
