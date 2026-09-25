import type { ChatMessage } from '@api-gateway/shared/types.js';

// OpenAI-spec message content can be one of:
//   - string                        (plain text)
//   - null                          (assistant with tool_calls only)
//   - Array<ContentBlock>           (multimodal envelope)
//
// The array envelope is preserved end-to-end for providers whose wire format
// can express media (see providers/*.ts); `contentToString` extracts text only
// and is for the places that genuinely need a string (redaction, logging,
// instructions). Provider adapters must use `blockMediaKind`/`mediaUrlOf`
// rather than flattening, or the media is silently destroyed.
export type ContentTextBlock = { type: 'text'; text: string };
export type ContentBlock = ContentTextBlock | { type: string; [key: string]: unknown };

/** The three input modalities the gateway models. */
export type MediaKind = 'image' | 'audio' | 'video';

/**
 * Block `type` spellings seen across clients and providers, mapped to the
 * modality they carry. Includes the Responses API spellings (`input_image`,
 * `input_audio`, `input_video`) and the chat-completions spellings, plus the
 * bare forms some SDKs emit.
 */
const BLOCK_TYPE_TO_MEDIA: Record<string, MediaKind> = {
  // image
  image_url: 'image',
  image: 'image',
  input_image: 'image',
  // audio
  input_audio: 'audio',
  audio_url: 'audio',
  audio: 'audio',
  // video
  video_url: 'video',
  video: 'video',
  input_video: 'video',
};

/**
 * Which modality a content block carries, or null when it is not a media
 * block (text blocks, tool results, unknown shapes).
 *
 * This is the single place new block spellings get added — provider adapters
 * must not carry their own type tables (two divergent private copies of an
 * image extractor previously accepted different block sets).
 */
export function blockMediaKind(block: unknown): MediaKind | null {
  if (block === null || typeof block !== 'object') return null;
  if (!('type' in block)) return null;
  const type = block.type;
  if (typeof type !== 'string') return null;
  return BLOCK_TYPE_TO_MEDIA[type] ?? null;
}

/** Non-empty string at `holder[key]`, or null. */
function stringField(holder: Record<string, unknown>, key: string): string | null {
  const value = holder[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The URL (or synthesized data URL) a media block points at, or null when the
 * block carries no usable payload. `kind` is the value the caller already got
 * from `blockMediaKind`, so the block field names can be interpreted.
 *
 * Accepted shapes, tried in order:
 *   - `{ <kind>_url: { url } }` / `{ <kind>_url: "..." }` — the OpenAI
 *     multimodal envelope and its bare-string variant
 *   - `{ input_audio: { data, format } }` — synthesized into a data URL so
 *     every downstream converter sees one shape
 *   - `{ url: "..." }` — flattened form
 */
export function mediaUrlOf(block: unknown, kind: MediaKind): string | null {
  if (block === null || typeof block !== 'object') return null;
  const holder: Record<string, unknown> = { ...block };

  const direct = stringField(holder, `${kind}_url`);
  if (direct) return direct;

  const nested = holder[`${kind}_url`];
  if (nested !== null && typeof nested === 'object' && 'url' in nested) {
    const url = nested.url;
    if (typeof url === 'string' && url.length > 0) return url;
  }

  // Bare field spelling: `{ type: 'image', image: url }` (Google-lineage
  // clients). The old per-adapter extractors accepted this shape, so the
  // shared classifier must too or those requests lose their media.
  const bare = stringField(holder, kind);
  if (bare) return bare;

  // `{ input_audio: { data, format } }` on the Responses API spelling.
  if (kind === 'audio') {
    const inputAudio = holder.input_audio;
    if (inputAudio !== null && typeof inputAudio === 'object') {
      const data = 'data' in inputAudio ? inputAudio.data : undefined;
      const format = 'format' in inputAudio ? inputAudio.format : undefined;
      if (typeof data === 'string' && data.length > 0) {
        if (data.startsWith('data:')) return data;
        const fmt = typeof format === 'string' && format.length > 0 ? format : 'wav';
        return `data:audio/${fmt};base64,${data}`;
      }
      if ('url' in inputAudio) {
        const url = inputAudio.url;
        if (typeof url === 'string' && url.length > 0) return url;
      }
    }
    const bare = stringField(holder, 'data');
    if (bare) {
      if (bare.startsWith('data:')) return bare;
      const fmt = stringField(holder, 'format') ?? 'wav';
      return `data:audio/${fmt};base64,${bare}`;
    }
  }

  const flat = stringField(holder, 'url');
  if (flat) return flat;

  return null;
}

/** True when the content array carries at least one block of `kind`. */
export function contentHasMedia(content: unknown, kind: MediaKind): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => blockMediaKind(block) === kind);
}

/** True when any message carries a media block of `kind`. */
export function messageHasMedia(messages: ChatMessage[], kind: MediaKind): boolean {
  return messages.some((m) => contentHasMedia(m.content, kind));
}

/**
 * Every media kind present anywhere in the message list. Used to discover the
 * modality requirements of a request in one pass.
 */
export function collectRequiredModalities(messages: ChatMessage[]): Set<MediaKind> {
  const required = new Set<MediaKind>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const kind = blockMediaKind(block);
      if (kind) required.add(kind);
    }
  }
  return required;
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        const block = b as { type?: string; text?: unknown };
        // OpenAI blocks carry type:'text'; Gemini-lineage agents (Qwen Code,
        // AionUI) send part-style `{ text }` with no type at all — accept any
        // block whose `text` is a string and whose type doesn't say it's
        // something else. (#200)
        if (typeof block?.text === 'string' && (block.type === 'text' || block.type === undefined)) {
          return block.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

// True if the content array carries an image block. Thin wrapper over the
// shared classifier — kept because it predates `contentHasMedia` and is
// imported by the proxy route.
export function contentHasImage(content: unknown): boolean {
  return contentHasMedia(content, 'image');
}

// True if any message carries an image content block. Used to route image
// requests only to vision-capable models (#118, #125).
export function messageHasImage(messages: ChatMessage[]): boolean {
  return messageHasMedia(messages, 'image');
}

// Provider reasoning wire-keys observed in the wild. LogFare, Ollama, and
// OpenRouter use `reasoning`; CommandCode uses `reasoningContent` on its SSE
// event shape. The gateway's canonical outbound field is `reasoning_content`
// (ChatCompletionChunk.choices[].delta.reasoning_content in shared/types.ts).
export const REASONING_ALIAS_KEYS = ['reasoning', 'reasoningContent'] as const;

/**
 * Move any non-empty reasoning alias on `holder` to `reasoning_content` and
 * delete the aliases. Mutates in place, idempotent. Does nothing when no alias
 * and no `reasoning_content` are present, so a provider that sends only
 * `reasoning: ''` on its role preamble keeps its exact current shape.
 *
 * Preference: an existing non-empty `reasoning_content` wins; aliases are
 * stripped even in that case so downstream sees exactly one reasoning field.
 */
export function canonicalizeReasoningFields(
  holder: Record<string, unknown> | undefined | null,
): void {
  if (!holder || typeof holder !== 'object') return;
  const canonical = holder.reasoning_content;
  const hasCanonical = typeof canonical === 'string' && canonical.length > 0;
  let promoted: string | undefined;
  if (!hasCanonical) {
    for (const k of REASONING_ALIAS_KEYS) {
      const v = holder[k];
      if (typeof v === 'string' && v.length > 0) { promoted = v; break; }
    }
    if (promoted === undefined) return; // nothing real to canonicalize
    holder.reasoning_content = promoted;
  }
  for (const k of REASONING_ALIAS_KEYS) {
    if (k in holder) delete holder[k];
  }
}

// Normalize the OUTBOUND (provider → client) shape so we honor the OpenAI
// contract on the response path the same way `contentToString` does on the
// request path. Per spec, `choices[].delta.content` (streaming) and
// `choices[].message.content` (non-stream) are strings; some providers
// (e.g. Mistral magistral) return an array of content blocks. Forwarding the
// array verbatim breaks string-consuming clients ("expected str, got list")
// and, mid-stream, drops the turn's tool calls. We coerce array content to a
// string while leaving `tool_calls` and every other field untouched. Mutates
// and returns the same object (chunks are parsed fresh from JSON per frame, so
// in-place mutation is safe). Non-array content passes through unchanged. (#166)
export function normalizeOutboundContent<T>(payload: T): T {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return payload;
  for (const choice of choices) {
    const delta = (choice as { delta?: { content?: unknown } })?.delta;
    if (delta && Array.isArray(delta.content)) {
      delta.content = contentToString(delta.content);
    }
    const message = (choice as { message?: { content?: unknown } })?.message;
    if (message && Array.isArray(message.content)) {
      message.content = contentToString(message.content);
    }
  }
  return payload;
}
