import { describe, it, expect } from 'vitest';
import {
  anthropicToChatMessages,
  chatCompletionToAnthropic,
  type AnthropicInboundRequest,
} from '../../services/anthropic-translate.js';

describe('Anthropic inbound translation (F6)', () => {
  describe('anthropicToChatMessages', () => {
    it('translates a simple string-content user message', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('extracts system message outside the messages array', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' });
    });

    it('extracts system from array form', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        system: [{ type: 'text', text: 'System prompt' }],
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.messages[0]).toEqual({ role: 'system', content: 'System prompt' });
    });

    it('translates array text blocks to a single user message', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
        }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Part 1\nPart 2' });
    });

    it('translates tool_result blocks to tool role messages', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_123', content: '42' }],
        }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        role: 'tool',
        content: '42',
        tool_call_id: 'call_123',
      });
    });

    it('translates assistant tool_use blocks to tool_calls', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will use the tool' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
          ],
        }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.messages).toHaveLength(1);
      const msg = result.messages[0] as any;
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('I will use the tool');
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      });
    });

    it('translates Anthropic tools to OpenAI function tools', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'get_weather',
          description: 'Get the weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        }],
      };
      const result = anthropicToChatMessages(req);
      expect(result.tools).toHaveLength(1);
      expect(result.tools![0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      });
    });

    it('translates tool_choice: any → required', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: 'any',
      };
      const result = anthropicToChatMessages(req);
      expect(result.tool_choice).toBe('required');
    });

    it('translates tool_choice: {type:"tool", name:"X"} → function', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: { type: 'tool', name: 'get_weather' },
      };
      const result = anthropicToChatMessages(req);
      // C07: the internal /v1/chat/completions schema requires the OpenAI
      // nested shape — the flat Anthropic form was rejected with 400.
      expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    });

    it('passes through temperature, top_p, max_tokens', () => {
      const req: AnthropicInboundRequest = {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 100,
      };
      const result = anthropicToChatMessages(req);
      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBe(0.9);
      expect(result.max_tokens).toBe(100);
    });
  });

  describe('chatCompletionToAnthropic', () => {
    it('translates a simple text response', () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        model: 'groq/test',
        choices: [{
          message: { content: 'Hello!' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = chatCompletionToAnthropic(openaiResponse);
      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello!' });
      expect(result.stop_reason).toBe('end_turn');
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });

    it('translates tool_calls to tool_use blocks', () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        model: 'groq/test',
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = chatCompletionToAnthropic(openaiResponse);
      // text block with empty content is omitted when there's no text
      const toolUseBlocks = result.content.filter(b => b.type === 'tool_use');
      expect(toolUseBlocks).toHaveLength(1);
      expect(toolUseBlocks[0]).toEqual({
        type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' },
      });
      expect(result.stop_reason).toBe('tool_use');
    });

    it('translates reasoning_content to thinking blocks', () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        model: 'groq/test',
        choices: [{
          message: { content: 'Answer', reasoning_content: 'Let me think...' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = chatCompletionToAnthropic(openaiResponse);
      expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'Let me think...' });
      expect(result.content[1]).toEqual({ type: 'text', text: 'Answer' });
    });

    it('maps finish_reason: length → max_tokens', () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        model: 'groq/test',
        choices: [{ message: { content: '...' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const result = chatCompletionToAnthropic(openaiResponse);
      expect(result.stop_reason).toBe('max_tokens');
    });
  });
});
