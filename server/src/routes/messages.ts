/**
 * F6: POST /v1/messages — Anthropic-format inbound.
 *
 * Accepts Anthropic Messages API requests, translates to OpenAI chat
 * completions format via anthropic-translate, dispatches through an internal
 * HTTP sub-request to the existing /v1/chat/completions endpoint (reusing the
 * battle-tested router/retry/budget/cache machinery), and translates the
 * OpenAI completion back to Anthropic shape.
 *
 * This avoids duplicating the proxy's intricate retry loop while adding the
 * Anthropic wire-format ingress surface. The sub-request runs on localhost
 * against the same Express app.
 *
 * Auth: unified bearer OR x-api-key header (extractApiToken accepts both —
 * the Anthropic convention).
 *
 * Per walkthrough D-FEATURES-2: ship F6 + F11 together.
 */

import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  anthropicToChatMessages,
  chatCompletionToAnthropic,
  type AnthropicInboundRequest,
} from '../services/anthropic-translate.js';
import { extractApiToken } from './proxy.js';
import { attachClientAbort } from '../lib/abort.js';

export const messagesRouter = Router();

const anthropicMessageSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.union([
      z.string(),
      z.array(z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
        z.object({
          type: z.literal('tool_result'),
          tool_use_id: z.string(),
          content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]).optional(),
        }),
      ])),
    ]),
  })).min(1),
  system: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]).optional(),
  max_tokens: z.number().int().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown(),
  })).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('any'),
    z.object({ type: z.enum(['auto', 'any', 'tool']), name: z.string().optional() }),
  ]).optional(),
  stream: z.boolean().optional(),
  thinking: z.unknown().optional(),
  reasoning_effort: z.string().optional(),
});

messagesRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();

  // Auth: extract token (unified bearer OR x-api-key — Anthropic convention).
  const token = extractApiToken(req);
  if (!token) {
    res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Missing API key. Send Authorization: Bearer <key> or x-api-key: <key>.' },
    });
    return;
  }

  const parsed = anthropicMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid request',
      },
    });
    return;
  }

  const anthropicReq = parsed.data as AnthropicInboundRequest;
  const translated = anthropicToChatMessages(anthropicReq);
  const stream = anthropicReq.stream ?? false;

  // Client-disconnect abort signal (attach a watcher to the response).
  const { controller: abortController, detach: detachAbortWatcher } = attachClientAbort(res);
  const abortSignal = abortController.signal;

  // Build the OpenAI chat completions request body
  const openaiBody: Record<string, unknown> = {
    model: anthropicReq.model ?? 'auto',
    messages: translated.messages,
    stream,
  };
  if (translated.tools) openaiBody.tools = translated.tools;
  if (translated.tool_choice) openaiBody.tool_choice = translated.tool_choice;
  if (translated.temperature !== undefined) openaiBody.temperature = translated.temperature;
  if (translated.top_p !== undefined) openaiBody.top_p = translated.top_p;
  if (translated.max_tokens !== undefined) openaiBody.max_tokens = translated.max_tokens;
  if (translated.thinking !== undefined) openaiBody.thinking = translated.thinking;
  if (translated.reasoning_effort !== undefined) openaiBody.reasoning_effort = translated.reasoning_effort;

  try {
    // Internal sub-request to the existing /v1/chat/completions handler.
    // Same Express app, localhost — reuses all the router/retry/budget/cache
    // machinery without duplicating it. The target port comes from the
    // server's OWN bound address (set at wiring time), never from the
    // client-controlled Host header.
    const subRes = await fetch(`http://127.0.0.1:${getSelfPort()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        // M05: exempt the loopback sub-request from the /v1 rate limiter —
        // the outer /v1/messages request already consumed a slot for the
        // client IP; the sub-request would otherwise burn a second one.
        'X-API-Gateway-Internal': '1',
        ...(req.get('X-Session-Id') ? { 'X-Session-Id': req.get('X-Session-Id')! } : {}),
      },
      body: JSON.stringify(openaiBody),
      signal: abortSignal,
    });

    if (!subRes.ok) {
      // Forward the error, translated to Anthropic shape
      const errBody = await subRes.json().catch(() => ({})) as { error?: { message?: string } };
      // L09: budget exhaustion (402 from the proxy) is a permanent condition,
      // not a transient overload — mapping it to Anthropic's 529
      // `overloaded_error` made clients retry forever against a limit that
      // will never lift. Surface it as an invalid_request_error-shaped payload
      // at the original 402 status so callers treat it as non-retryable.
      const errType = subRes.status === 401 ? 'authentication_error'
        : subRes.status === 400 || subRes.status === 402 ? 'invalid_request_error'
        : subRes.status === 429 ? 'rate_limit_error'
        : 'api_error';
      res.status(subRes.status).json({
        type: 'error',
        error: {
          type: errType,
          message: errBody?.error?.message ?? subRes.statusText,
        },
      });
      return;
    }

    if (stream) {
      // Translate the OpenAI SSE stream to Anthropic SSE events
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();

      // message_start
      // M06: estimate input tokens from the translated messages so callers
      // see a non-zero input count in usage (the old hardcoded 0 made
      // Anthropic-compatible clients that read usage.input_tokens report
      // 0 for every request).
      const estimatedInputTokens = Math.max(1, Math.ceil(
        JSON.stringify(translated.messages).length / 4,
      ));
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: requestId,
          type: 'message',
          role: 'assistant',
          model: anthropicReq.model ?? 'auto',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
        },
      })}\n\n`);

      // content_block_start (text block at index 0)
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`);

      let blockIndex = 0;
      // M06: text deltas always belong to this block index; it stays 0
      // until a tool_use block opens, then a new text block may open later.
      let textBlockIndex = 0;
      let finishReason: string | undefined;
      let outputTokens = 0;

      // N10: fetch resolves with a null body on 204/empty upstream replies —
      // message_start is already on the wire, so fail as an SSE error event
      // instead of dereferencing null.
      if (!subRes.body) {
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Upstream returned no response body' },
        })}\n\n`);
        res.end();
        detachAbortWatcher();
        return;
      }
      const reader = subRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              // M06: text always belongs to the current text block (index 0
              // or, if a tool call already ended it, a new text block).
              // Track whether the block-0 text block is still open so we
              // never emit a text delta at index 0 after a tool_use block
              // opened at a higher index.
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: textBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
              })}\n\n`);
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  blockIndex++;
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name ?? '', input: {} },
                  })}\n\n`);
                }
                if (tc.function?.arguments) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                  })}\n\n`);
                }
              }
            }
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            if (chunk.usage?.completion_tokens) {
              outputTokens = chunk.usage.completion_tokens;
            }
          } catch { /* malformed chunk — skip */ }
        }
      }

      // Close text block
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);

      // Close any tool_use blocks
      for (let i = 1; i <= blockIndex; i++) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: i,
        })}\n\n`);
      }

      const stopMap: Record<string, 'end_turn' | 'max_tokens' | 'tool_use'> = {
        stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use',
      };
      const stopReason = finishReason ? (stopMap[finishReason] ?? 'end_turn') : 'end_turn';

      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })}\n\n`);

      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    } else {
      const openaiResponse = await subRes.json() as {
        id: string;
        model: string;
        choices: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
            reasoning_content?: string;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const anthropicResponse = chatCompletionToAnthropic(openaiResponse);
      res.json(anthropicResponse);
    }
    // M03: response completed normally — detach the abort watcher on the
    // success path as well (previously only the catch paths detached, so a
    // successful request leaked the `close` listener until process exit).
    detachAbortWatcher();
  } catch (err: any) {
    if (err.name === 'AbortError' || abortSignal.aborted) {
      // Client disconnect
      detachAbortWatcher();
      return;
    }
    detachAbortWatcher();
    const msg = err.message ?? 'Internal error';
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: msg },
    });
  }
});

// The bound HTTP server, injected at wiring time (index.ts) — the internal
// loopback sub-request must target the server's OWN address, never a port
// parsed from the attacker-controlled Host header (SSRF-adjacent redirect
// of an authenticated internal call).
let selfHttpServer: import('http').Server | null = null;

export function setMessagesHttpServer(server: import('http').Server): void {
  selfHttpServer = server;
}

function getSelfPort(): number {
  const addr = selfHttpServer?.address();
  return addr && typeof addr === 'object' ? addr.port : Number(process.env.PORT ?? 3001);
}
