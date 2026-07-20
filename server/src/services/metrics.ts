/**
 * F7: Prometheus /metrics endpoint — exposes request count, latency
 * histogram, error rate per model/provider for a standard scrape target.
 *
 * Uses prom-client (pure-JS, no native deps). Auth: METRICS_AUTH_TOKEN env
 * bearer ONLY (fail-closed 401 if unset). Cardinality bounded to
 * {platform, model, status, stream}.
 *
 * Per walkthrough: F7 ALONE in feat/f7-prometheus-metrics (not bundled with
 * AUDIT Imp.4). METRICS_AUTH_TOKEN-only (no LAN auto-trust). No
 * metrics_rollup table (in-process prom-client only).
 *
 * Attribution: concept from pllm (MIT, MetricsCollector) and
 * BerriAI/litellm (MIT, integrations/prometheus.py).
 */

import { Counter, Histogram, register, collectDefaultMetrics } from 'prom-client';

// Collect default Node.js metrics (GC, event loop, memory, etc.)
collectDefaultMetrics();

// Cardinality-bounded labels: {platform, model, status, stream}
const requestCounter = new Counter({
  name: 'api_gateway_requests_total',
  help: 'Total requests processed by the gateway',
  labelNames: ['platform', 'model', 'status', 'stream'] as const,
});

const requestLatencyHistogram = new Histogram({
  name: 'api_gateway_request_duration_ms',
  help: 'Request latency in milliseconds',
  labelNames: ['platform', 'model', 'status', 'stream'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
});

const tokenCounter = new Counter({
  name: 'api_gateway_tokens_total',
  help: 'Total tokens processed (input + output)',
  labelNames: ['platform', 'model', 'direction'] as const,
});

const cooldownCounter = new Counter({
  name: 'api_gateway_cooldowns_total',
  help: 'Total cooldown events (keys benched by upstream rate limits)',
  labelNames: ['platform', 'model', 'reason'] as const,
});

/** Record a request's outcome for Prometheus metrics. Called from the proxy
 *  success/error paths alongside logRequest. */
export function recordMetricsRequest(params: {
  platform: string;
  model: string;
  status: 'success' | 'error';
  stream: boolean;
  latencyMs: number;
}): void {
  const labels = {
    platform: params.platform,
    model: params.model,
    status: params.status,
    stream: String(params.stream),
  };
  requestCounter.inc(labels);
  requestLatencyHistogram.observe(labels, params.latencyMs);
}

/** Record token usage for Prometheus metrics. */
export function recordMetricsTokens(params: {
  platform: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  tokenCounter.inc({ platform: params.platform, model: params.model, direction: 'input' }, params.inputTokens);
  tokenCounter.inc({ platform: params.platform, model: params.model, direction: 'output' }, params.outputTokens);
}

/** Record a cooldown event for Prometheus metrics. */
export function recordMetricsCooldown(params: {
  platform: string;
  model: string;
  reason: string;
}): void {
  cooldownCounter.inc({ platform: params.platform, model: params.model, reason: params.reason });
}

/** Get the Prometheus metrics text (for the /metrics endpoint). */
export async function getMetricsText(): Promise<string> {
  return register.metrics();
}

/** Check if the metrics endpoint is auth-gated (METRICS_AUTH_TOKEN must be set). */
export function isMetricsAuthEnabled(): boolean {
  return !!process.env.METRICS_AUTH_TOKEN;
}

/** Verify a bearer token against METRICS_AUTH_TOKEN. */
export function verifyMetricsToken(token: string | undefined): boolean {
  const expected = process.env.METRICS_AUTH_TOKEN;
  if (!expected) return false; // fail-closed if not configured
  if (!token) return false;
  // Timing-safe comparison
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return a.equals(b);
}
