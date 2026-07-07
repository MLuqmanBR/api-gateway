// Single source of truth for the reasoning-model-family detector.
// Used by both `buildModelCapabilities` (capability metadata on /v1/models)
// and the streaming/non-streaming think-tag gate in `routes/proxy.ts`.
// Heuristic substring matching on the model id — true for chat-tuned CoT
// families only; we never claim reasoning capability on bare base models.
export function isReasoningModelId(modelId: string): boolean {
  const ml = modelId.toLowerCase();
  return ml.includes('-thinking')                       // k2-thinking, glm-thinking, etc.
    || ml.includes('-think')                          // gpt-oss "think" tier variants
    || ml.includes('reasoning')                       // nemotron-reasoning, command-a-reasoning
    || ml.includes('deepseek-r1')                     // R1 family
    || ml.includes('deepseek-v4')                     // V4 = V3.2 + reasoning
    || ml.includes('qwq')                             // QwQ preview
    || ml.includes('magistral')                       // Mistral Magi*
    || ml.includes('o3-') || ml.includes('o4-')       // OpenAI o-series
    || ml.includes('gpt-oss')                         // openai/gpt-oss-* = chain-of-thought tier
    || ml.includes('minimax-m3')                       // MiniMax M3 = thinking tier
    || ml.includes('minimax-m2')                       // MiniMax M2.x (m2.5/m2.7) = thinking tier (#292)
    || ml.includes('minimaxai/minimax-m')             // NVIDIA-style id `minimaxai/minimax-mN` — catch M2.x/M3 family (#292)
    || ml.includes('glm-5.2')                          // GLM 5.2 — reasoning tier on every host (incl. aggregatord coding-glm-5.2-free) (#292)
    || ml.includes('mimo-v');                            // Xiaomi MiMo family — reasoning-capable
}
