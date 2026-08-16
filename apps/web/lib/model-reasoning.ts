import { z } from "zod";
import type { ProviderOptionsByProvider } from "@open-agents/agent";
import { isClaudeModelId, isGeminiModelId } from "@/lib/models";

/**
 * A single reasoning-effort choice as actually accepted by a given
 * upstream, paired with the label shown in the UI. `value` is the exact
 * string sent over the wire (providerOptions.openai.reasoningEffort /
 * google.thinkingConfig.thinkingLevel) -- never translated or remapped,
 * so what you pick in the UI is what the upstream actually receives.
 */
export interface ReasoningEffortLevel {
  value: string;
  label: string;
}

export type ReasoningEffort = string;

/**
 * The vocabulary most reasoning-capable upstreams share (OpenAI-style
 * low/medium/high, and Gemini's low/medium/high thinkingLevel). Used for
 * every model in REASONING_CAPABLE_MODEL_IDS unless MODEL_REASONING_LEVELS
 * has a more specific entry below.
 */
const DEFAULT_LEVELS: ReasoningEffortLevel[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * Per-model overrides for upstreams whose real accepted vocabulary differs
 * from the low/medium/high default. Only list models here where the
 * values genuinely differ -- everything else falls back to DEFAULT_LEVELS.
 */
const MODEL_REASONING_LEVELS: Record<string, ReasoningEffortLevel[]> = {
  // Confirmed 2026-08-15 via live probe against tokenrouter
  // (OpenAI-compat route): the upstream rejects "high" outright --
  // "reasoning_effort must be low, medium, or xhigh" -- so xhigh is this
  // model's real top tier, not a translation of "high". Token counts
  // across repeated runs on the same hard prompt: low ~546-818 reasoning
  // tokens, medium ~517, xhigh ~240-247 -- counterintuitively xhigh used
  // the FEWEST reasoning tokens, not the most. That's the upstream's own
  // behavior, shown here faithfully rather than remapped to what the
  // label implies.
  "qwen3.8-max-free": [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "XHigh" },
  ],
  // Confirmed 2026-08-15 from the HF endpoint's own docs: reasoning_effort
  // accepts none/low/medium/xhigh, default xhigh. Unlike qwen3.8-max-free,
  // this checkpoint genuinely supports turning thinking off entirely via
  // "none" -- included here since it's a real, documented capability
  // difference, not a guess.
  "qwen3.8-27b": [
    { value: "none", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "xhigh", label: "XHigh" },
  ],
};

export function getReasoningEffortLevels(
  modelId: string,
): ReasoningEffortLevel[] {
  return MODEL_REASONING_LEVELS[modelId] ?? DEFAULT_LEVELS;
}

// Loose format check only -- real validity is per-model (see
// sanitizeReasoningEffort below), since different upstreams accept
// different vocabularies (e.g. qwen3.8-max-free's low/medium/xhigh).
export const reasoningEffortSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z]+$/);

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
/**
 * Claude's low/medium/high effort selector doesn't map to Anthropic's
 * `effort` field here -- confirmed via live probe 2026-08-16 that
 * thinking:{type:"adaptive"} is a silent no-op through FreeModel's Claude
 * passthrough (0 thinking_tokens either way). Instead each level maps to
 * a legacy `thinking.budget_tokens` value that's confirmed to actually
 * scale real thinking-token output through that same route (319 tokens
 * at budget 2000, 409 at budget 16000, same prompt). See
 * getAnthropicSettings in packages/agent/models.ts for the default
 * (unselected) budget.
 */
const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
  low: 2000,
  medium: 8000,
  high: 16000,
};

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
  // Confirmed 2026-08-15 via live probe against tokenrouter: reasoning is
  // ALWAYS on for this checkpoint -- chat_template_kwargs.enable_thinking:
  // false is hard-rejected ("Qwen3.8 open text checkpoints require
  // thinking; enable_thinking=false is unsupported"). reasoning_effort IS
  // honored; see MODEL_REASONING_LEVELS above for this model's real
  // low/medium/xhigh vocabulary.
  "qwen3.8-max-free",
  // Confirmed 2026-08-15 via live probe directly against the HF endpoint:
  // reasoning trace comes back in message.reasoning, honors reasoning_effort
  // exactly per the model's own docs (none/low/medium/xhigh, default xhigh).
  "qwen3.8-27b",
  // Confirmed 2026-08-16 via live probe against FreeModel's OpenAI-shaped
  // route (api.freemodel.dev): reasoning_content comes back on
  // message.reasoning_content (same DeepSeek-style field @ai-sdk/openai-
  // compatible already parses into reasoning-start/delta/end parts, see
  // sharedProvider()'s comment on that), and its length/detail visibly
  // differs between reasoning_effort low and high on the same hard prompt.
  // gpt-5.6-luna re-added 2026-08-16 per owner request despite occasional
  // "upstream service temporarily unavailable" flakiness on FreeModel's
  // side -- that's an availability issue, not a reasoning-param issue.
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  // Confirmed 2026-08-16 via live probe against FreeModel's Claude
  // passthrough (cc.freemodel.dev): legacy thinking genuinely works and
  // scales with budget_tokens for every one of these ids, haiku included
  // (471 thinking_tokens at budget 8000) -- see ANTHROPIC_THINKING_BUDGETS
  // above and toReasoningProviderOptions below for how the UI's low/
  // medium/high maps to a real budget_tokens value for this provider.
  "claude-opus-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
]);

export function isReasoningCapableModel(modelId: string): boolean {
  return REASONING_CAPABLE_MODEL_IDS.has(modelId);
}

/**
 * Validates a stored/requested reasoning effort value against the model
 * that will actually serve the request, using that model's real accepted
 * vocabulary (see getReasoningEffortLevels). Returns null if the model
 * doesn't support reasoning effort or the value isn't one of that model's
 * recognized levels -- callers should treat null as "use the model's
 * default reasoning behavior".
 */
export function sanitizeReasoningEffort(
  modelId: string,
  value: string | null | undefined,
): ReasoningEffort | null {
  if (!value || !isReasoningCapableModel(modelId)) {
    return null;
  }
  const levels = getReasoningEffortLevels(modelId);
  return levels.some((level) => level.value === value) ? value : null;
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
 *
 * `effort` here is always one of that model's own getReasoningEffortLevels
 * values (validated by sanitizeReasoningEffort before this is called), so
 * it's passed straight through with no per-model remapping needed.
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

  if (isClaudeModelId(modelId)) {
    // See ANTHROPIC_THINKING_BUDGETS above for why this is a budget_tokens
    // lookup and not a passthrough `effort` field. Falls back to the
    // "medium" budget for any effort value outside the known set (should
    // never happen -- sanitizeReasoningEffort already validates against
    // getReasoningEffortLevels before this is called).
    return {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: ANTHROPIC_THINKING_BUDGETS[effort] ?? ANTHROPIC_THINKING_BUDGETS.medium,
        },
      },
    };
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
