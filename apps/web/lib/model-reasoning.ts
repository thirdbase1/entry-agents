import { z } from "zod";
import type { ProviderOptionsByProvider } from "@open-agents/agent";
import { isGeminiModelId } from "@/lib/models";

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
  // NOTE 2026-08-12: glm-5.2 is currently DOWN end-to-end (iamhc route
  // times out at 90s, opencode-zen fallback blocked -- no payment method
  // on Opencode Zen workspace). Kept in this set since reasoning_effort
  // was already wired before the outage and should resume working once
  // either upstream is back; this is an availability issue, not a param
  // issue.
  "glm-5.2",
  // Confirmed 2026-08-11 via live probe through entry-gateway (iamhc
  // route): reasoning_effort=max -> 16 reasoning_tokens, low -> 49,
  // extra_body.thinking.disabled -> 0. Genuinely gated by the param.
  "deepseek-v4-flash",
  // Confirmed 2026-08-12 via live probe (iamhc route): reasoning_effort
  // low -> 20 completion_tokens/short reasoning, high -> 55 completion_
  // tokens/136-char reasoning, none/xhigh -> rejected/ignored (StepFun
  // only supports low/medium/high, no xhigh -- matches their own docs).
  "step-3.7-flash",
  // Confirmed 2026-08-12 via live probe (opencode-zen route): reasoning
  // length scales with effort (low < high). Same OpenAI-compatible param
  // shape as the others.
  "hy3",
  // Gemini 3.x models (native @ai-sdk/google client, not the OpenAI-compat
  // shape -- see toReasoningProviderOptions below). Gemma models are
  // deliberately excluded: Google's free-tier Gemma line has no thinking
  // support at all, so a thinkingConfig field would just be an unsupported
  // no-op (or a rejected request, depending on the endpoint).
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  // Confirmed 2026-08-13 via Google's own docs (ai.google.dev/gemini-api/
  // docs/latest-model): GA release, default thinking_level=medium, tunable
  // low/medium/high. Same native @ai-sdk/google path as the other 3.x
  // Flash models above.
  "gemini-3.7-flash",
  // Confirmed 2026-08-15 via live probe against tokenrouter (OpenAI-compat
  // route): reasoning is ALWAYS on for this checkpoint --
  // chat_template_kwargs.enable_thinking:false is hard-rejected with
  // "Qwen3.8 open text checkpoints require thinking; enable_thinking=false
  // is unsupported". reasoning_effort IS honored but the upstream's own
  // accepted vocabulary is low/medium/xhigh, NOT low/medium/high --
  // sending "high" gets a 400 ("reasoning_effort must be low, medium, or
  // xhigh"). See EFFORT_VALUE_OVERRIDES below for the high->xhigh mapping
  // so the shared UI can keep using low/medium/high. Token counts across
  // repeated runs on the same hard prompt: low ~546-818 reasoning tokens,
  // medium ~517, xhigh ~240-247 -- counterintuitively XHIGH used the
  // FEWEST reasoning tokens, not the most. Naming is the upstream's own
  // choice, not a bug on our side; passing it through faithfully rather
  // than remapping based on assumed semantics.
  "qwen3.8-max-free",
]);

// Some upstreams don't share the UI's low/medium/high vocabulary. Map the
// UI value to whatever that specific model's API actually accepts here
// before it goes out over the wire, so the shared selector component never
// needs to know about per-model quirks.
const EFFORT_VALUE_OVERRIDES: Record<string, Partial<Record<ReasoningEffort, string>>> = {
  "qwen3.8-max-free": { high: "xhigh" },
};

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
 * Most model calls in this app go through a single createOpenAI()-based
 * client pointed at entry-gateway (see packages/agent/models.ts), regardless
 * of which upstream model actually serves the request (Kimi K3, DeepSeek,
 * Qwen, GLM, ...). The AI SDK's OpenAI provider always looks up its settings
 * under the literal key "openai" in providerOptions -- NOT a key derived
 * from the model id -- so a reasoning-effort override must be nested under
 * "openai" no matter what the base model actually is.
 *
 * Gemini models are the one exception (native @ai-sdk/google client, see
 * models.ts's isGeminiModelId branch of sharedProvider()) -- that client
 * only reads thinking settings from providerOptions.google.thinkingConfig,
 * so `effort` needs a modelId-aware branch here rather than always
 * assuming the shared "openai" shape. thinkingLevel accepts the same
 * low/medium/high vocabulary as the UI's reasoning selector, so `effort`
 * maps straight across with no translation.
 */
export function toReasoningProviderOptions(
  effort: ReasoningEffort | null,
  modelId: string,
): ProviderOptionsByProvider | undefined {
  if (!effort) {
    return undefined;
  }

  if (isGeminiModelId(modelId)) {
    return {
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: effort },
      },
    };
  }

  const mappedEffort = EFFORT_VALUE_OVERRIDES[modelId]?.[effort] ?? effort;

  return {
    openai: {
      reasoningEffort: mappedEffort,
      // OpenAI Responses items are not persisted when store is false.
      // Ensure this always carries the non-persistent setting so
      // follow-up turns never try to reference missing rs_* items.
      store: false,
    },
  };
}
