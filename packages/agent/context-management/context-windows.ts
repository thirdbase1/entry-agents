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
 *
 * Claude (claude-opus-5, claude-opus-4-6/4-7/4-8, claude-sonnet-4-6/5,
 * claude-haiku-4-5-20251001) and GPT-5.6 (gpt-5.6-sol/terra/luna) entries
 * below are pulled directly from the gateway's own route config
 * (context_window field on each FreeModel route, EXTRA_MODEL_ROUTES_JSON_2)
 * -- that's the actual advertised limit from the provider, not a guess.
 * Added 2026-08-16 after finding these fell through to a generic 200k
 * "claude" prefix match (opus is really 1M) or the 128k
 * DEFAULT_CONTEXT_WINDOW (gpt-5.6 had no match at all -- terra/luna are
 * really 400k, sol is really 1.05M), which meant compaction was firing far
 * earlier than necessary on exactly the models with the biggest windows.
 * The old dotted-version "claude-sonnet-4.5"/"claude-haiku-4.5" entries
 * were removed -- that duplicate provider route was retired in favor of
 * the FreeModel-routed IDs below.
 */

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 400_000,
  "gpt-5.6-luna": 400_000,
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
// (e.g. a new dated snapshot of an existing family). Kept intentionally
// on the low side of the family's smallest known variant (sonnet/haiku,
// 200k) rather than opus's 1M -- an unrecognized "claude-*" id defaulting
// to 1M would be the dangerous direction to guess wrong in.
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
