/**
 * F6: Anthropic inbound translation — converts Anthropic-format /v1/messages
 * requests to internal ChatMessage[] for routing through the existing proxy
 * machinery, and converts the OpenAI completion back to Anthropic shape.
 *
 * This is the INBOUND twin of providers/anthropic.ts (which does the OUTBOUND
 * OpenAI→Anthropic translation). Symmetric structure with that adapter:
 * text blocks flatten, tool_use/tool_result translate symmetrically.
 *
 * Per the walkthrough (D-FEATURES-2): translate Anthropic→OpenAI-compat FIRST
 * (normalize string content → [{type:text}]), then computeCacheKey.
 *
 * Attribution: concept from pllm (MIT, handlers/messages.go) and
 * decolua/9router (MIT, open-sse/translator/).
 */

import type { ChatMessage, ChatToolCall, ChatToolDefinition } from '@api-gateway/shared/types.js';

// ── Anthropic inbound types ──

export interface AnthropicInboundMessage {
  role: 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'text'; text: string }> }
  >;
}

export interface AnthropicInboundRequest {
  model: string;
  messages: AnthropicInboundMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: unknown;
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string } | 'auto' | 'any';
  stream?: boolean;
  // Anthropic's thinking config — translate to our internal `thinking` field.
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
  // Some clients send reasoning_effort directly (Claude Code variants).
  reasoning_effort?: string;
}

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

// ── Translation: Anthropic inbound → internal ChatMessage[] ──

export function anthropicToChatMessages(req: AnthropicInboundRequest): {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  thinking?: unknown;
  reasoning_effort?: string;
} {
  const messages: ChatMessage[] = [];

  // System: Anthropic carries it outside the messages array.
  if (req.system) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system.map(b => b.text).join('\n');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const m of req.messages) {
    if (m.role === 'user') {
      // User messages may carry text blocks or tool_result blocks.
      // tool_result blocks → OpenAI 'tool' role messages.
      if (typeof m.content === 'string') {
        messages.push({ role: 'user', content: m.content });
        continue;
      }
      // Separate text from tool_result blocks. tool_result blocks become
      // separate 'tool' messages; remaining text stays as one user message.
      const textParts: string[] = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content) ? block.content.map(b => b.text).join('\n') : '';
          messages.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: block.tool_use_id,
          } as ChatMessage);
        }
      }
      if (textParts.length > 0) {
        messages.push({ role: 'user', content: textParts.join('\n') });
      }
    } else if (m.role === 'assistant') {
      // Assistant messages may carry text + tool_use blocks.
      if (typeof m.content === 'string') {
        messages.push({ role: 'assistant', content: m.content });
        continue;
      }
      const textParts: string[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const msg: ChatMessage = {
        role: 'assistant',
        content: textParts.join('\n'),
      } as ChatMessage;
      if (toolCalls.length > 0) {
        (msg as any).tool_calls = toolCalls;
      }
      messages.push(msg);
    }
  }

  // Tools: Anthropic uses input_schema; we convert to JSON schema.
  let tools: ChatToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.input_schema ?? {}) as Record<string, unknown>,
      },
    }));
  }
  let tool_choice: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } } | undefined;
  if (req.tool_choice) {
    if (typeof req.tool_choice === 'string') {
      tool_choice = req.tool_choice === 'any' ? 'required' : 'auto';
    } else if (req.tool_choice.type === 'any') {
      tool_choice = 'required';
    } else if (req.tool_choice.type === 'tool' && req.tool_choice.name) {
      // Emit the OpenAI wire shape — this object is forwarded verbatim into
      // the internal /v1/chat/completions sub-request, whose schema requires
      // { type: 'function', function: { name } }.
      tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
    } else {
      tool_choice = 'auto';
    }
  }

  return {
    messages,
    tools,
    tool_choice: tool_choice as any,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    thinking: req.thinking,
    reasoning_effort: req.reasoning_effort,
  };
}

// ── Translation: OpenAI completion → Anthropic response ──

export function chatCompletionToAnthropic(
  openaiResponse: {
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
  },
): AnthropicResponse {
  const choice = openaiResponse.choices?.[0];
  const msg = choice?.message;
  const content: AnthropicContentBlock[] = [];

  // Thinking block first (if present)
  if (msg?.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content });
  }

  // Text content
  if (msg?.content) {
    content.push({ type: 'text', text: msg.content });
  }

  // Tool calls → tool_use blocks
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: unknown;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  // stop_reason mapping: OpenAI → Anthropic
  const stopMap: Record<string, 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence'> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    function_call: 'tool_use',
  };
  const stopReason = choice?.finish_reason
    ? (stopMap[choice.finish_reason] ?? 'end_turn')
    : 'end_turn';

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResponse.usage?.completion_tokens ?? 0,
    },
  };
}

