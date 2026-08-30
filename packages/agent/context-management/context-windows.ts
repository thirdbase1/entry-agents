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
 * REWRITTEN 2026-08-17: every value below was re-verified by web search
 * against each vendor's own docs/blog (not assumed/guessed) -- most of
 * the old numbers here were a flat 128k placeholder that badly
 * under-counted several models actually rated at 500k-1M by their
 * vendors. Sources, per model:
 *   - Claude (opus-5/4-8/4-7/4-6, sonnet-5/4-6): platform.claude.com's
 *     own context-windows doc -- 1M is the DEFAULT for these, no beta
 *     header needed. claude-haiku-4-5-20251001: same doc + Anthropic's
 *     own Haiku 4.5 announcement -- 200k.
 *   - GPT-5.6 (sol/terra/luna): developers.openai.com model pages +
 *     OpenAI's own gpt-5.6 launch post -- all three are 1,050,000, not
 *     just Sol (terra/luna were wrongly set to 400k before).
 *   - grok-4.5: xAI's own model page / consistently reported 500,000
 *     across independent trackers -- was wrongly set to 128k.
 *   - minimax-m3: platform.minimax.io's own API docs -- 1,000,000. Was
 *     wrongly set to 128k.
 *   - mimo-v2-pro: mimo.xiaomi.com's own product page -- 1,000,000. Was
 *     wrongly set to 128k.
 *   - qwen3.6-flash / qwen3.6-plus / qwen3.7-max / qwen3.7-plus:
 *     qwen.ai's own blog posts -- 1,000,000 for all four. Were wrongly
 *     set to 128k.
 *   - qwen3.8-max: qwen.ai's own launch post cites a 256K-token native
 *     window (some resellers advertise an extended 1M tier, but the
 *     vendor's own baseline number is 256k -- kept conservative).
 *   - step-3.7-flash: StepFun's own GitHub repo + consistent 3rd-party
 *     hosts -- 256,000.
 *   - ling-3.0-flash-free: Ant Group's own release announcement --
 *     native 262,144 (256k), extendable to 1M by request; kept the
 *     native/default number.
 *   - hy3: consistently reported as 262,144 (256k) everywhere it's
 *     hosted, including by Tencent's own release messaging -- was
 *     wrongly set to 128k.
 *   - kimi-k3, glm-5.2: CONFLICTING evidence -- both vendors (Moonshot,
 *     Zhipu) advertise a 1M native window on their own platforms, but
 *     third-party reseller hosting (OpenRouter) caps them at 256k and
 *     200k respectively. Since our own model provider (FreeModel /
 *     Opencode Zen) is itself a reseller of the same kind, and I had no
 *     way to empirically confirm which cap it actually enforces, I kept
 *     the lower, reseller-observed number here rather than the vendor's
 *     theoretical max -- consistent with this file's stated
 *     "under-estimating is safe, over-estimating risks a hard error"
 *     philosophy. Revisit if this can be confirmed against FreeModel
 *     directly.
 *   - deepseek-v4-flash, deepseek-v4-pro: left at 128k -- conflicting/
 *     unclear public info on whether these specific route names get
 *     DeepSeek's newer 1M-context variant or the older 128k one, so kept
 *     the safe low number rather than guess.
 *   - glm-5.3-flash: B.AI's own model listing (the provider this app
 *     routes glm-5.3-flash through) -- 1,000,000. Was missing from this
 *     table entirely and silently fell back to DEFAULT_CONTEXT_WINDOW
 *     (128k), which made auto-compaction fire on every single turn of a
 *     long session at "~200% of 128k" (found 2026-08-30 in production
 *     runtime logs) even though the real window is ~26% used at that
 *     size.
 *   - deepseek-v4-flash-vision-exp: B.AI's own listing for this exact
 *     route -- 1,000,000 (distinct from deepseek-v4-flash above, whose
 *     separate ambiguity note still stands).
 *   - qwen3.8-flash: B.AI's own listing -- 256K native context,
 *     matching the conservative number already used for qwen3.8-max.
 */

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "kimi-k3": 256_000,
  "deepseek-v4-flash": 128_000,
  "deepseek-v4-pro": 128_000,
  "deepseek-v4-flash-vision-exp": 1_000_000,
  "glm-5.2": 200_000,
  "glm-5.3-flash": 1_000_000,
  hy3: 262_144,
  "grok-4.5": 500_000,
  "mimo-v2-pro": 1_000_000,
  "minimax-m3": 1_000_000,
  "ling-3.0-flash-free": 262_144,
  "qwen3.6-flash": 1_000_000,
  "qwen3.6-plus": 1_000_000,
  "qwen3.7-max": 1_000_000,
  "qwen3.7-plus": 1_000_000,
  "qwen3.8-flash": 256_000,
  "qwen3.8-max": 256_000,
  "step-3.7-flash": 256_000,
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
