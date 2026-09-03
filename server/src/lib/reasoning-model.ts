// Single source of truth for the reasoning-model-family detector.
// Used by both `buildModelCapabilities` (capability metadata on /v1/models)
// and the streaming/non-streaming think-tag gate in `routes/proxy.ts`.
// Heuristic substring matching on the model id — true for chat-tuned CoT
// families only; we never claim reasoning capability on bare base models.
export function isReasoningModelId(modelId: string): boolean {
  const ml = modelId.toLowerCase();
  return ml.includes('-think')                         // -thinking / -think tier variants (k2-thinking, glm-thinking, gpt-oss think)
    || ml.includes('reasoning')                       // nemotron-reasoning, command-a-reasoning
    || ml.includes('deepseek-r1')                     // R1 family
    || ml.includes('deepseek-v4')                     // V4 = V3.2 + reasoning
    || ml.includes('qwq')                             // QwQ preview
    || ml.includes('magistral')                       // Mistral Magi*
    // OpenAI o-series: bare `o3`/`o4` and suffixed forms (`o3-mini`,
    // `openai/o3`). Token-boundary match so alnum-adjacent ids (e.g.
    // `mimo3`, `pollinations`) can never trip it.
    || /(?:^|[^a-z0-9])o[34](?:$|[^a-z0-9])/.test(ml)
    || ml.includes('gpt-oss')                         // openai/gpt-oss-* = chain-of-thought tier
    || ml.includes('minimax-m3')                       // MiniMax M3 = thinking tier
    || ml.includes('minimax-m2')                       // MiniMax M2.x (m2.5/m2.7) = thinking tier (#292)
    || ml.includes('minimaxai/minimax-m')             // NVIDIA-style id `minimaxai/minimax-mN` — catch M2.x/M3 family (#292)
    || ml.includes('glm-5.2')                          // GLM 5.2 — reasoning tier on every host (#292)
    || ml.includes('mimo-v');                            // Xiaomi MiMo family — reasoning-capable
}
