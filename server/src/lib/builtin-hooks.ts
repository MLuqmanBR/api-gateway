/**
 * F1 (refactor-only): register the three built-in request transforms on the
 * HookPipeline. Called once at module load from proxy.ts. The transforms
 * themselves stay in their original files (`lib/think-tags.ts`,
 * `lib/tool-call-rescue.ts`, `services/context-handoff.ts`); this file just
 * wraps them as pipeline hooks with the right phase + gating.
 *
 * D-FEATURES-5: the default policy is EMPTY — no operator-added hooks. The
 * three built-ins below are the entire hook surface. Operator `vm.Script`
 * hooks, CRUD admin routes, and a dashboard editor are deferred to F1b.
 */

import { pipeline } from './hook-pipeline.js';
import { extractThinkTags } from './think-tags.js';
import { rescueInlineToolCalls } from './tool-call-rescue.js';
import { maybeInjectContextHandoff } from '../services/context-handoff.js';

let registered = false;

/** Register the three built-in hooks on the process-wide pipeline singleton.
 *  Idempotent — safe to call from multiple entry points (proxy.ts, responses.ts). */
export function registerBuiltInHooks(): void {
  if (registered) return;
  registered = true;

  // Pre-call: context-handoff injects a summary of the prior model's context
  // on a model switch, so the new model sees the conversation history.
  pipeline.registerPreCall({
    id: 'context-handoff',
    run(ctx) {
      if (ctx.mode === 'off' || !ctx.sessionKey || !ctx.selectedModelKey) return undefined;
      return maybeInjectContextHandoff({
        mode: ctx.mode as 'on_model_switch',
        sessionKey: ctx.sessionKey,
        messages: ctx.messages,
        selectedModelKey: ctx.selectedModelKey,
      });
    },
  });

  // Post-call-success: tool-rescue runs FIRST so it sees the FULL response —
  // including any dialect blocks a model emitted mid-reasoning — before the
  // think-tag extractor moves <think>…</think> out of content. Extraction is
  // not confused by dialect tokens either way: only the literal `<think>`
  // opener triggers it, never other angle-bracket markup
  // (think-tags.ts:11-12, rule 1).
  pipeline.registerPostCallSuccess({
    id: 'tool-rescue',
    run(ctx) {
      if (!ctx.wantsTools || ctx.hasExistingToolCalls) return undefined;
      const rescue = rescueInlineToolCalls(ctx.content, ctx.toolNames);
      if (!rescue.detected) return undefined;
      if (!rescue.calls) {
        // Unparseable dialect — dead turn. Let the throw propagate to the
        // proxy's retry loop, which fails over to the next model/key.
        throw new Error(`unparseable inline tool-call dialect: ${ctx.content.slice(0, 120)}`);
      }
      return {
        content: rescue.cleanText.length > 0 ? rescue.cleanText : '',
        toolCalls: rescue.calls,
        toolCallsDetected: true,
      };
    },
  });

  // Post-call-success: think-tags runs AFTER tool-rescue. Moves <think> blocks
  // from content to reasoning_content so clients see a clean answer + a
  // separate reasoning trace. Only runs on reasoning models.
  pipeline.registerPostCallSuccess({
    id: 'think-tags',
    run(ctx) {
      if (!ctx.isReasoningModel) return undefined;
      if (ctx.content.length === 0) return undefined;
      const think = extractThinkTags(ctx.content);
      if (!think.extracted) return undefined;
      return {
        content: think.visible,
        reasoning: think.reasoning.length > 0 ? think.reasoning : ctx.reasoning,
      };
    },
  });
}
