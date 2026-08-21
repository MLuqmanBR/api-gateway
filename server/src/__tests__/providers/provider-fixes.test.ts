// H11/H22/H05 regressions: CommandCode streamed tool indices, Anthropic
// validateKey billing probe, Google key-in-URL removal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── H11: CommandCode NDJSON stream with tool-use events ───────────────────
import { CommandCodeProvider } from '../../providers/commandcode.js';

function ndjsonStream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      controller.enqueue(enc.encode(lines));
    },
  });
}

describe('H11 — CommandCode tool-use/tool-delta streaming', () => {
  it('two tool-use calls get distinct indices and tool-delta args survive', async () => {
    const provider = new CommandCodeProvider();
    const events = [
      { type: 'tool-use', toolCallId: 'call_1', toolName: 'get_weather' },
      { type: 'tool-delta', text: '{"city":' },
      { type: 'tool-delta', text: '"Paris"}' },
      { type: 'tool-use', toolCallId: 'call_2', toolName: 'get_time' },
      { type: 'tool-delta', text: '{"tz":"UTC"}' },
    ];
    const fetchMock = vi.fn().mockImplementation(async (url: any) => {
      // The provider also fetches the npm registry for its version header —
      // route that to a plain JSON response so it can't consume the stream.
      if (String(url).includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
      }
      return new Response(ndjsonStream(events), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const chunks: any[] = [];
      for await (const chunk of provider.streamChatCompletion('k', [{ role: 'user', content: 'x' }], 'm')) {
        chunks.push(chunk);
      }
      const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
      // Both calls registered with distinct indices (pre-fix: both index 0).
      const indices = new Set(toolChunks.map((c) => c.choices[0].delta.tool_calls[0].index));
      expect(indices.size).toBeGreaterThanOrEqual(2);
      // tool-delta arguments are NOT dropped (pre-fix: prevIdx=-1 → null).
      const argChunks = toolChunks.filter((c) => c.choices[0].delta.tool_calls[0].function?.arguments);
      const joined = argChunks.map((c) => c.choices[0].delta.tool_calls[0].function.arguments).join('');
      expect(joined).toContain('"Paris"');
      expect(joined).toContain('UTC');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── H22: Anthropic validateKey probes count_tokens, not a generation ───────
import { AnthropicCompatProvider } from '../../providers/anthropic.js';

describe('H22 — Anthropic validateKey uses the free count_tokens probe', () => {
  it('POSTs /v1/messages/count_tokens and never /v1/messages when available', async () => {
    const provider = new AnthropicCompatProvider({ platform: 'anthropic', name: 'Anthropic', baseUrl: 'http://127.0.0.1:46124' });
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const ok = await provider.validateKey('sk-ant-test');
      expect(ok).toBe(true);
      expect(calls).toEqual(['http://127.0.0.1:46124/v1/messages/count_tokens']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to a minimal messages probe when count_tokens is absent (404)', async () => {
    const provider = new AnthropicCompatProvider({ platform: 'anthropic', name: 'Anthropic', baseUrl: 'http://127.0.0.1:46124' });
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('count_tokens')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const ok = await provider.validateKey('sk-ant-test');
      expect(ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain('/v1/messages');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('401 on count_tokens marks the key invalid', async () => {
    const provider = new AnthropicCompatProvider({ platform: 'anthropic', name: 'Anthropic', baseUrl: 'http://127.0.0.1:46124' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));
    try {
      expect(await provider.validateKey('sk-ant-bad')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── H05: Google sends the key in a header, never the URL ───────────────────
import { GoogleProvider } from '../../providers/google.js';

describe('H05 — Google API key never appears in the URL', () => {
  beforeEach(() => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('generateContent carries x-goog-api-key header, no ?key= query', async () => {
    const provider = new GoogleProvider();
    await provider.chatCompletion('AIza-super-secret-key', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash');
    const call = (fetch as any).mock.calls[0];
    const url = String(call[0]);
    expect(url).not.toContain('key=');
    expect(url).toContain('models/gemini-2.5-flash:generateContent');
    expect(call[1].headers['x-goog-api-key']).toBe('AIza-super-secret-key');
  });

  it('validateKey hits /models with the header, no query key', async () => {
    const provider = new GoogleProvider();
    await provider.validateKey('AIza-another-key');
    const call = (fetch as any).mock.calls.at(-1);
    const url = String(call[0]);
    expect(url.endsWith('/models')).toBe(true);
    expect(url).not.toContain('?');
    expect(call[1].headers['x-goog-api-key']).toBe('AIza-another-key');
  });
});
