/**
 * Conservative, static per-model context-window sizes used ONLY to decide
 * when auto-compaction should trigger (see auto-compact.ts).
 *
 * This is deliberately independent of apps/web's live gateway-fetched
 * catalog (apps/web/lib/models-with-context.ts) -- packages/agent has no
 * business making a network call on every agent step just to size a
 * safety threshold, and a rough number is good enough here: worst case we
 * compact a little earlier or later than the model's exact real limit.
 *
 * Values are deliberately picked on the LOW side. Under-estimating a
 * model's context window means we compact a bit early (wastes a little
 * budget on an unnecessary pass) -- over-estimating risks a hard
 * context_length_exceeded error, which is worse. Keep
 * DEFAULT_CONTEXT_WINDOW conservative for the same reason.
 */

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4.5": 200_000,
  "claude-haiku-4.5": 200_000,
  "kimi-k3": 256_000,
  "deepseek-v4-flash": 128_000,
  "deepseek-v4-pro": 128_000,
  "glm-5.2": 128_000,
  hy3: 128_000,
  "grok-4.5": 128_000,
  "mimo-v2-pro": 128_000,
  "minimax-m3": 128_000,
  "ling-3.0-flash-free": 128_000,
  "qwen3.6-flash": 128_000,
  "qwen3.6-plus": 128_000,
  "qwen3.7-max": 128_000,
  "qwen3.7-plus": 128_000,
  "qwen3.8-max": 128_000,
  "step-3.7-flash": 128_000,
};

// Fallback substring matches for model ids that aren't an exact hit above
// (e.g. a new dated snapshot of an existing family).
const PREFIX_CONTEXT_WINDOWS: Array<[string, number]> = [
  ["claude", 200_000],
  ["kimi", 256_000],
];

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function getContextWindowForModel(modelId: string): number {
  const known = KNOWN_CONTEXT_WINDOWS[modelId];
  if (known) return known;

  const lowerId = modelId.toLowerCase();
  for (const [prefix, contextWindow] of PREFIX_CONTEXT_WINDOWS) {
    if (lowerId.includes(prefix)) return contextWindow;
  }

  return DEFAULT_CONTEXT_WINDOW;
}
