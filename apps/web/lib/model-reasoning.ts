import { z } from "zod";
import type { ProviderOptionsByProvider } from "@open-agents/agent";

export const REASONING_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

export const reasoningEffortSchema = z.enum(REASONING_EFFORT_LEVELS);

// Models confirmed to accept `reasoningEffort` in the OpenAI-compatible
// provider-options schema when routed through entry-gateway. Add a model id
// here only once you've verified the upstream provider actually honors
// reasoning_effort -- some routes silently ignore fields they don't
// recognize, which would make the selector a no-op for that model.
//
// NOTE: kimi-k3 is deliberately NOT included even though it's a capable
// reasoning model -- it's currently in lib/model-availability.ts's
// DISABLED_MODEL_IDS (Opencode Zen workspace has no payment method on file
// yet). Add it here once that's resolved.
const REASONING_CAPABLE_MODEL_IDS = new Set<string>([
  "deepseek-v4-pro",
  "glm-5.2",
  // Confirmed 2026-08-11 via live probe through entry-gateway (iamhc
  // route): reasoning_effort=max -> 16 reasoning_tokens, low -> 49,
  // extra_body.thinking.disabled -> 0. Genuinely gated by the param.
  "deepseek-v4-flash",
]);

export function isReasoningCapableModel(modelId: string): boolean {
  return REASONING_CAPABLE_MODEL_IDS.has(modelId);
}

/**
 * Validates a stored/requested reasoning effort value against the model
 * that will actually serve the request. Returns null if the model doesn't
 * support reasoning effort or the value isn't a recognized level -- callers
 * should treat null as "use the model's default reasoning behavior".
 */
export function sanitizeReasoningEffort(
  modelId: string,
  value: string | null | undefined,
): ReasoningEffort | null {
  if (!value || !isReasoningCapableModel(modelId)) {
    return null;
  }
  const parsed = reasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * All model calls in this app go through a single createOpenAI()-based
 * client pointed at entry-gateway (see packages/agent/models.ts), regardless
 * of which upstream model actually serves the request (Kimi K3, DeepSeek,
 * Qwen, GLM, ...). The AI SDK's OpenAI provider always looks up its settings
 * under the literal key "openai" in providerOptions -- NOT a key derived
 * from the model id -- so a reasoning-effort override must be nested under
 * "openai" no matter what the base model actually is.
 */
export function toReasoningProviderOptions(
  effort: ReasoningEffort | null,
): ProviderOptionsByProvider | undefined {
  if (!effort) {
    return undefined;
  }

  return {
    openai: {
      reasoningEffort: effort,
      // OpenAI Responses items are not persisted when store is false.
      // Ensure this always carries the non-persistent setting so
      // follow-up turns never try to reference missing rs_* items.
      store: false,
    },
  };
}
