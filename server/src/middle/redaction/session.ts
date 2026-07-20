/**
 * Stage-1 programmatic redaction session — Row B2-3.
 *
 * Per-request object created by applyOutbound (Row B2-6) when redaction is
 * enabled. Deep-copies the message array, redacts known secrets via the span
 * engine, records placeholder→value mappings for un-redaction, and verifies
 * each transform byte-equality.
 */

import type { ChatMessage } from '@api-gateway/shared/types.js';
import { findKnownSpans, applySpans, verifyRedaction, unredact, type KnownSecret } from './spans.js';
import { getActiveSecretsForRedaction } from './store.js';

export class RedactionSession {
  private readonly map = new Map<string, string>(); // placeholder → value
  private secrets: KnownSecret[];

  constructor(secrets?: KnownSecret[]) {
    this.secrets = secrets ?? getActiveSecretsForRedaction();
  }

  /** Redact all known secrets in a message array. Returns a NEW array —
   * the original is never mutated. Each transformed string is verified via
   * verifyRedaction; on failure (should be impossible — assertion), the
   * original string is used and a warning is logged once. */
  redactOutbound(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => this.redactMessage(msg));
  }

  /** Rebuild the secrets list from the store. Called after the interceptor
   * adds new secrets (Row B2-4) so a re-run of redactOutbound picks them up. */
  rebuildSecrets(): void {
    this.secrets = getActiveSecretsForRedaction();
  }

  private redactMessage(msg: ChatMessage): ChatMessage {
    const copy: ChatMessage = { ...msg };
    if (copy.content != null) copy.content = this.redactContent(copy.content);
    if (copy.reasoning_content != null && typeof copy.reasoning_content === 'string') {
      copy.reasoning_content = this.redactString(copy.reasoning_content);
    }
    if (copy.tool_calls?.length) {
      copy.tool_calls = copy.tool_calls.map(tc => ({
        ...tc,
        function: { ...tc.function, arguments: this.redactString(tc.function.arguments) },
      }));
    }
    return copy;
  }

  private redactContent(content: ChatMessage['content']): ChatMessage['content'] {
    if (typeof content === 'string') return this.redactString(content);
    if (Array.isArray(content)) {
      return content.map(block => {
        if (typeof block === 'string') return this.redactString(block);
        // Leave image_url and unknown block types untouched — only redact
        // the `text` field on text blocks.
        if (block && typeof block === 'object' && typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) {
          return { ...block, text: this.redactString(block.text) };
        }
        return block;
      });
    }
    return content; // null or unknown shape
  }

  private redactString(text: string): string {
    const spans = findKnownSpans(text, this.secrets);
    if (spans.length === 0) return text;
    const { out, applied } = applySpans(text, spans);
    if (!verifyRedaction(text, out, applied)) {
      // Should be impossible — the span engine is deterministic. Fall back
      // to the original string to preserve correctness. Log once.
      console.warn('[Middle] Redaction verifyRedaction failed — using original string. This is a bug.');
      return text;
    }
    for (const span of applied) {
      this.map.set(span.placeholder, span.value);
    }
    return out;
  }

  /** Non-streaming inverse: placeholder → value via the session map. */
  unredactText(text: string): string {
    return unredact(text, this.map);
  }

  /** Get the session map for seeding StreamUnredactor (Row B2-5). */
  getMap(): ReadonlyMap<string, string> {
    return this.map;
  }

  /** Whether any redactions were applied. */
  hasRedactions(): boolean {
    return this.map.size > 0;
  }
}
