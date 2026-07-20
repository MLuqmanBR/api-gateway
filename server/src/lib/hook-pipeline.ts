/**
 * F1 (refactor-only): HookPipeline — uniform registration + execution surface
 * for the three built-in request transforms (context-handoff, tool-rescue,
 * think-tags). F7 (Prometheus) and F8 (webhooks) subscribe to this pipeline
 * to observe hook executions without coupling to the individual transforms.
 *
 * Design:
 * - `registerPreCall` / `registerPostCallSuccess` store hooks in order.
 * - `runPreCall` / `runPostCallSuccess` execute hooks in registration order,
 *   threading the mutated state through each hook (re-stamp behavior: a
 *   downstream hook sees the output of the upstream hook).
 * - `subscribe` adds an observation listener (F7/F8 surface). Listeners
 *   receive (phase, hookId, ctx, result) for each hook that returned a mutation.
 *   Listener errors are swallowed — an observer must never break the pipeline.
 * - D-FEATURES-5 default policy = EMPTY — no hooks beyond the three built-ins
 *   (operator-added vm.Script hooks are deferred to F1b).
 *
 * License: concept-only (litellm S3 MIT, tokenomics S9 MIT, pllm S6 MIT).
 */

import type { ChatMessage } from '@api-gateway/shared/types.js';
import type { RescuedToolCall } from './tool-call-rescue.js';

export type HookPhase = 'pre-call' | 'post-call-success';

export interface PreCallContext {
  /** Context-handoff mode: 'off' or 'on_model_switch'. */
  mode: string;
  /** Session key for sticky handoff tracking. */
  sessionKey?: string;
  /** Inbound messages (will be threaded through hooks, possibly mutated). */
  messages: ChatMessage[];
  /** The model key selected by the router for this attempt. */
  selectedModelKey?: string;
}

export interface PreCallResult {
  messages: ChatMessage[];
  injected: boolean;
  injectedTokens: number;
}

export interface PostCallSuccessContext {
  /** Response content (will be threaded through hooks, possibly mutated). */
  content: string;
  /** Existing reasoning_content (threaded through, possibly appended). */
  reasoning: string;
  /** Tool names for dialect rescue detection. */
  toolNames: Set<string>;
  /** Whether the model is a reasoning model (gates think-tag extraction). */
  isReasoningModel: boolean;
  /** Whether the request bears tools (gates tool-rescue). */
  wantsTools: boolean;
  /** Whether the response already has structured tool_calls (skip rescue). */
  hasExistingToolCalls: boolean;
}

export interface PostCallSuccessResult {
  content: string;
  reasoning: string;
  /** Rescued tool calls (null = no rescue; array = rescued calls). */
  toolCalls: RescuedToolCall[] | null;
  /** True when a dialect was detected (caller must decide fail vs. apply). */
  toolCallsDetected: boolean;
}

export interface Hook<C, R> {
  id: string;
  run(ctx: C): Partial<R> | void;
}

export type HookListener = (
  phase: HookPhase,
  hookId: string,
  ctx: unknown,
  result: unknown,
) => void;

export class HookPipeline {
  private preCallHooks: Hook<PreCallContext, PreCallResult>[] = [];
  private postCallSuccessHooks: Hook<PostCallSuccessContext, PostCallSuccessResult>[] = [];
  private listeners: HookListener[] = [];

  registerPreCall(hook: Hook<PreCallContext, PreCallResult>): void {
    this.preCallHooks.push(hook);
  }

  registerPostCallSuccess(hook: Hook<PostCallSuccessContext, PostCallSuccessResult>): void {
    this.postCallSuccessHooks.push(hook);
  }

  /** F7/F8 subscribe surface. Listener errors are swallowed — an observer
   *  must never break the request pipeline. Returns an unsubscribe function. */
  subscribe(listener: HookListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Run pre-call hooks in registration order, threading mutated messages. */
  runPreCall(ctx: PreCallContext): PreCallResult {
    let result: PreCallResult = { messages: ctx.messages, injected: false, injectedTokens: 0 };
    for (const hook of this.preCallHooks) {
      const hookCtx: PreCallContext = { ...ctx, messages: result.messages };
      const hookResult = hook.run(hookCtx);
      if (hookResult) {
        result = { ...result, ...hookResult };
        this.emit('pre-call', hook.id, ctx, hookResult);
      }
    }
    return result;
  }

  /** Run post-call-success hooks in registration order, threading mutated
   *  content and reasoning (re-stamp). Tool-rescue runs before think-tags
   *  so the think-tag extractor only ever sees visible text. */
  runPostCallSuccess(ctx: PostCallSuccessContext): PostCallSuccessResult {
    let result: PostCallSuccessResult = {
      content: ctx.content,
      reasoning: ctx.reasoning,
      toolCalls: null,
      toolCallsDetected: false,
    };
    for (const hook of this.postCallSuccessHooks) {
      const hookCtx: PostCallSuccessContext = {
        ...ctx,
        content: result.content,
        reasoning: result.reasoning,
      };
      const hookResult = hook.run(hookCtx);
      if (hookResult) {
        result = { ...result, ...hookResult };
        this.emit('post-call-success', hook.id, ctx, hookResult);
      }
    }
    return result;
  }

  /** Introspection — returns the registered hook ids (F7/F8 dashboards). */
  getRegisteredHooks(): { phase: HookPhase; id: string }[] {
    return [
      ...this.preCallHooks.map(h => ({ phase: 'pre-call' as const, id: h.id })),
      ...this.postCallSuccessHooks.map(h => ({ phase: 'post-call-success' as const, id: h.id })),
    ];
  }

  private emit(phase: HookPhase, hookId: string, ctx: unknown, result: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(phase, hookId, ctx, result);
      } catch {
        // An observer must never break the pipeline.
      }
    }
  }
}

/** Singleton pipeline — the process-wide hook registry + execution surface. */
export const pipeline = new HookPipeline();
