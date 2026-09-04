// /v1/audio/{transcriptions,translations} — OpenAI-compatible batch audio
// passthrough. Mounts under /v1 (inherits the blanket proxy rate limiter).
// Enforcement order mirrors chat: auth 401 → parse 400 → size 413 →
// allowlist 403 (service) → budget 402 → dispatch. Unified-key requests are
// exempt from allowlist + budget, exactly like chat.
import { Router } from 'express';
import express from 'express';
import type { Request, Response } from 'express';
import { extractApiToken, authenticateRequest } from './proxy.js';
import {
  parseAudioRequest,
  resolveTranscriptionModel,
  runTranscription,
  estimateTranscriptionCostCents,
  TranscriptionError,
  type ParsedAudioRequest,
} from '../services/transcriptions.js';
import { checkAndReserve, recordSpend, releaseBudget } from '../services/budgets.js';

export const audioRouter = Router();

// 26 MB raw cap covers a 25 MB file + the multipart envelope overhead.
// Express itself 413s anything past this before the handler runs.
const MULTIPART = express.raw({ type: 'multipart/form-data', limit: '26mb' });
const MAX_FILE_BYTES = 25 * 1024 * 1024;

audioRouter.post('/audio/transcriptions', MULTIPART, (req, res) => handle(req, res, 'transcriptions'));
audioRouter.post('/audio/translations', MULTIPART, (req, res) => handle(req, res, 'translations'));

// 128 kbps audio ≈ 16 KB per second; Groq bills a 10 s minimum. Conservative
// — never underestimates what the provider will actually bill.
function estimatedSeconds(fileSizeBytes: number): number {
  return Math.max(10, Math.ceil(fileSizeBytes / 16_000));
}

function clientError(res: Response, status: number, message: string, type: string): void {
  res.status(status).json({ error: { message, type } });
}

async function handle(req: Request, res: Response, kind: 'transcriptions' | 'translations'): Promise<void> {
  const token = extractApiToken(req);
  const auth = authenticateRequest(token);
  if (!auth.authenticated) {
    clientError(res, 401, 'Invalid API key', 'authentication_error');
    return;
  }
  let parsed: ParsedAudioRequest;
  if (!Buffer.isBuffer(req.body)) {
    clientError(res, 400, 'multipart/form-data body required', 'invalid_request_error');
    return;
  }
  const contentType = req.headers['content-type'] ?? '';
  try {
    parsed = await parseAudioRequest(contentType, req.body);
  } catch {
    clientError(res, 400, 'invalid multipart body', 'invalid_request_error');
    return;
  }
  if (parsed.stream) {
    clientError(res, 400, 'streaming transcription not supported', 'invalid_request_error');
    return;
  }
  const file = parsed.file;
  if (!file) {
    clientError(res, 400, 'file field is required', 'invalid_request_error');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    res.status(413).json({ error: { message: 'File exceeds 25 MB limit', type: 'invalid_request_error' } });
    return;
  }

  // Resolve the model BEFORE budgeting so the estimate prices the right row.
  const row = resolveTranscriptionModel(parsed.model);
  if (!row) {
    clientError(res, 400, `unknown transcription model: '${parsed.model}'`, 'invalid_request_error');
    return;
  }

  // Client-key enforcement (audio mirrors chat): allowlist flows into the
  // service (403s before dispatch), budget reserves/records here.
  const clientKey = auth.clientKey;
  const clientModelAllowlist = clientKey?.modelAllowlist?.length ? clientKey.modelAllowlist : null;

  let estCents = 0;
  let budgetReserved = false;
  if (clientKey) {
    estCents = estimateTranscriptionCostCents(row.price_per_hour_usd ?? 0, estimatedSeconds(file.size));
    const budgetResult = checkAndReserve('client_key', clientKey.id, estCents);
    if (!budgetResult.allowed) {
      res.status(402).json({
        error: {
          type: 'budget_exhausted',
          message: `Budget exhausted (${budgetResult.exhaustedPeriod} limit reached)`,
          overage_cents: budgetResult.overageCents,
          scope: budgetResult.scope,
          period: budgetResult.exhaustedPeriod,
        },
      });
      return;
    }
    budgetReserved = true;
  }

  try {
    const result = await runTranscription({
      kind,
      model: parsed.model,
      fields: parsed.fields,
      file,
      clientModelAllowlist,
    });
    if (clientKey && budgetReserved) {
      const actualCents = estimateTranscriptionCostCents(
        result.row.price_per_hour_usd ?? 0,
        result.actualSeconds ?? estimatedSeconds(file.size),
      );
      recordSpend('client_key', clientKey.id, actualCents, estCents);
    }
    res.status(result.status).type('json').send(result.body);
  } catch (err: unknown) {
    if (clientKey && budgetReserved) {
      releaseBudget('client_key', clientKey.id, estCents);
    }
    const status = err instanceof TranscriptionError ? err.status : 502;
    const type = status === 400 || status === 403
      ? 'invalid_request_error'
      : status === 429
        ? 'rate_limit_error'
        : 'server_error';
    const message = err instanceof Error ? err.message : 'unknown';
    res.status(status).json({ error: { message: `transcription error: ${message}`, type } });
  }
}
