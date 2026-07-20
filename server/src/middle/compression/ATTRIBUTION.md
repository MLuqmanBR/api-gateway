# Compression Layer — Attribution & Measurement Provenance

## Overview

The `server/src/middle/compression/` module implements prompt compression for the
api-gateway middle layer. The techniques and safety scaffolding are concept-ports
(adapted ideas, not code copies) from the following open-source projects.

## Attribution

### headroom (Apache-2.0, © Headroom Contributors)

- **Source:** `chopratejas/headroom` (`crates/headroom-core/src/transforms/`)
- **What was adapted:**
  - SmartCrusher concept (Kneedle-adaptive-K + always-keep constraints + SimHash
    dedup + min-savings floor)
  - TOON `[N]{cols}` CSV-schema lossless re-render concept
  - `compress.py` inflation guard + fail-open + net-cost gate concepts
  - `Kompress-v2-base` `_KOMPRESS_MUST_KEEP_RE` regex (literal pattern)
  - The `--protect-tool-results` precedence lesson (we default `role:"tool"`
    lossless)
- **Attribution statement:** "Adapted from headroom (Headroom Contributors,
  Apache-2.0) SmartCrusher — concept port, not code-copy"
- **Code lifted:** No — the reference is Rust+Python; this is original TS.

### caveman-compress (MIT, © Julius Brussee)

- **Source:** `JuliusBrussee/caveman` (`plugins/caveman/skills/caveman-compress/scripts/`)
- **What was adapted:**
  - Eligibility extension/whitelist + content-type detectors
  - Byte-exact post-condition validators (fenced code / URLs / headings / paths /
    inline-code Counter) + retry-or-restore scaffolding
- **Attribution statement:** "Safety-scaffold adapted from caveman-compress
  (Julius Brussee, MIT) — concept port, original TS implementation"
- **Code lifted:** No — ported as TS regex equivalents.

### ponytail (MIT, © Dietrich Gebert)

- **Source:** `DietrichGebert/ponytail`
- **What was adapted:**
  - Safety-floor off-limits framing (trust-boundary validation, error handling,
    security)
  - Measurement-methodology pattern for the fuzz harness (Row B1-6)
- **Attribution statement:** "Safety-floor framing and measurement methodology
  inspired by ponytail (Dietrich Gebert, MIT)"
- **Code lifted:** No — framing only.

## Measurement Provenance

Per `.upgrade-findings/batch5-caveman-headroom-ponytail.md`, every "X% savings"
number cited from the reference projects was measured by code, not a bare README
claim:

- **SmartCrusher** "60-95% fewer tokens (JSON data), 15-20% (coding agents)" —
  `benchmarks/agent_cost_benchmark.py:13` "50-80% on tool outputs" in CODE, plus
  parity-fixture-locked tests.
- **TOON `[N]{cols}`** — measured by `benchmarks/bench_latency.py` +
  `TabularCompressionResult::compression_ratio` in CODE.
- **caveman** "65% average output reduction" — computed by `benchmarks/run.py`
  via Anthropic SDK (needs API key to reproduce; README table is the
  regeneratable artifact).
- **Kompress** `f1=0.9130` `keep_rate=0.8097` — in the source docstring (NOT
  README), measured on `dataset_v2` test split (n=500).
- **ponytail** "−54% LOC, −22% tokens, −20% cost, −27% time, 100% safe" —
  `benchmarks/results/2026-06-18-agentic.md` COMMITTED corrected run (after
  owning + fixing a contamination bug in the prior 2026-06-17 run).

## "Concept Port, Not Code Lift" Statement

The api-gateway compression layer is an original TypeScript implementation. The
algorithms (SmartCrusher subset selection, SimHash dedup, Kneedle adaptive K,
TOON CSV-schema render, inflation guard, off-limits span detection,
byte-exact validator) were re-derived in TypeScript based on the concepts
documented in the reference projects. No source code was copied, translated, or
machine-converted. The reference implementations are Rust (headroom) and Python
(caveman-compress); a direct port would be a language conversion, not a
concept port.

## Deferred / Out-of-Scope (v1)

The following techniques from the reference projects are NOT shipped in v1:

| Technique | Source | Reason |
|---|---|---|
| CodeCompressor (tree-sitter AST elision) | headroom | NOT byte-exact (body elision); requires per-language WASM grammars (install-surface) |
| Kompress-v2-base (ONNX ML text) | headroom | 261 MB ONNX, native, AVX2/PyTorch runtime — no portability |
| Ponytail rules-injection / SKILL.md | ponytail | Output-side system-prompt skill injection, not prompt-byte compression |
| Tabular/Spreadsheet ingest | headroom | Niche for LLM-proxy use case (.xlsx/.csv attachments are rare inbound) |
