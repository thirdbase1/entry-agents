// Changed 2026-08-17: deepseek-v4-flash was left as a "TEMP" default from
// an old 2026-08-11 ling-3.0-flash-free outage, then got admin-disabled
// itself on 2026-08-17 -- meaning any request that fell through to this
// default was guaranteed to fail. Using gpt-5.6-luna instead: it's the
// free-tier model (see FREE_PLAN_MODEL_ID in lib/billing/plans.ts), so it's
// verified working and always enabled by definition. This is only used as
// the INITIAL selection when no model has been chosen yet -- if a model a
// user actually picked turns out to be disabled, resolveChatModelSelection
// throws a clear error instead of silently substituting this (or any other)
// default. See that file's docstring for why silent substitution was
// removed entirely.
export const DEFAULT_MODEL_ID = "gpt-5.6-luna";
export const APP_DEFAULT_MODEL_ID = "gpt-5.6-luna";
export const DEFAULT_CONTEXT_LIMIT = 200_000;
const TOKENS_PER_MILLION = 1_000_000;

/**
 * True for Google models (gemini-*, gemma-*) routed through the gateway's
 * native Gemini passthrough via @ai-sdk/google -- see the identically-
 * named isGeminiModelId in packages/agent/models.ts for the full
 * rationale (thinking-tag leak through the OpenAI-compat shim).
 *
 * Deliberately duplicated here instead of importing the one in
 * packages/agent/models.ts: this file (apps/web/lib/models.ts) has zero
 * imports and is safe to pull into Client Component bundles (e.g. the
 * model picker). @open-agents/agent's barrel index.ts re-exports
 * open-agent.ts -> tools/task.ts -> packages/sandbox, which requires
 * Node-only built-ins (stream/promises) that Next's Client Component SSR
 * webpack config can't resolve -- any *value* import from
 * "@open-agents/agent" (not just a `import type`) drags that whole graph
 * into any client-reachable bundle and breaks the build. Confirmed
 * 2026-08-13: this exact failure when apps/web/lib/model-reasoning.ts
 * (imported by the Client Component session-chat-content.tsx) switched
 * from a type-only import of that package to importing this function as
 * a value.
 */
export function isGeminiModelId(modelId: string): boolean {
  return modelId.startsWith("gemini-") || modelId.startsWith("gemma-");
}

/**
 * True for Claude models (claude-*) -- all routed through FreeModel's
 * cc.freemodel.dev Anthropic Messages passthrough as of 2026-08-16, when
 * the old "woino" direct-Anthropic-reseller provider (claude-sonnet-4.5,
 * claude-haiku-4.5) was removed in favor of FreeModel's full, working
 * Claude line (opus-5, opus-4-6/4-7/4-8, sonnet-4-6/5, haiku-4-5). See the
 * identically-named isClaudeModelId in packages/agent/models.ts for the
 * native-Anthropic-client rationale. Duplicated here for the same
 * client-bundle-safety reason as isGeminiModelId above (this file has
 * zero imports and is safe in Client Component bundles like the model
 * picker and the reasoning-effort selector).
 */
export function isClaudeModelId(modelId: string): boolean {
  return modelId.includes("claude");
}

export interface GatewayAvailableModel {
  id: string;
  name: string;
  description?: string | null;
  modelType?: string | null;
}

export interface AvailableModelCostTier {
  input?: number;
  output?: number;
  cache_read?: number;
  /**
   * Price per 1M tokens written to the prompt cache. Only a handful of
   * providers (Anthropic-style caching, some Zen models) charge a premium
   * for cache writes -- when unset, cache-write tokens are billed at the
   * base `input` rate (i.e. no special surcharge), matching how those
   * providers actually price an uncached write.
   */
  cache_write?: number;
}

export interface AvailableModelCost extends AvailableModelCostTier {
  context_over_200k?: AvailableModelCostTier;
  // Generic tiered-context keys, e.g. `context_over_272k` for
  // gpt-5.6-sol/terra/luna (their real threshold, per opencode.ai/docs/zen,
  // is 272K not 200K -- see resolveCostTier's fix below for why the
  // hardcoded `context_over_200k` field above was never enough on its
  // own). Declared as an index signature rather than adding named fields
  // per threshold since any future model can introduce its own cutoff
  // with zero type changes needed here.
  [key: `context_over_${number}k`]: AvailableModelCostTier | undefined;
}

export type AvailableModel = GatewayAvailableModel & {
  context_window?: number;
  cost?: AvailableModelCost;
};

export function getModelDisplayName(model: AvailableModel): string {
  const raw = model.name ?? model.id;
  // Cosmetic only: several Opencode Zen model ids carry a literal "-free"
  // suffix (mimo-v2.5-free, ling-3.0-flash-free, ...) baked into the id
  // itself for gateway routing purposes. The id must stay untouched
  // (routing, cost lookup, and the gateway config all key off it), but
  // showing "-free" in the picker reads as a stray leftover rather than
  // useful info, so strip it from the *displayed* label only.
  return raw.replace(/-free$/i, "");
}

export function getModelContextLimit(
  modelId: string,
  models: AvailableModel[],
): number | undefined {
  const directMatch = models.find((model) => model.id === modelId);
  if (
    typeof directMatch?.context_window !== "number" ||
    directMatch.context_window <= 0
  ) {
    return undefined;
  }

  return directMatch.context_window;
}

// Matches cost-object keys like "context_over_200k" or "context_over_272k".
// FIXED 2026-08-19: this used to only ever check the single hardcoded
// `context_over_200k` field (built for grok-4.5's threshold), so any
// model with a *different* cutoff -- gpt-5.6-sol/terra/luna's is 272K,
// per opencode.ai/docs/zen's own pricing table -- silently never got its
// tiered rate applied at all, always billing (and displaying) the base
// rate regardless of how large the request's context actually was.
// entry-gateway's own tieredCost() in server.js already generalized this
// exact same convention on 2026-08-18 (see that file's
// CONTEXT_TIER_KEY_RE) -- this mirrors that fix on the app side, which
// has its own independent copy of tier-resolution for the real debit
// (chat-post-finish.ts) and every usage-display surface (admin pages,
// profile page), all funneling through this one function.
const CONTEXT_TIER_KEY_RE = /^context_over_(\d+)k$/i;

function resolveCostTier(
  usage: { inputTokens: number },
  cost: AvailableModelCost | undefined,
): AvailableModelCostTier | undefined {
  if (!cost) {
    return undefined;
  }

  let winningThresholdTokens = -1;
  let winningTier: AvailableModelCostTier | undefined;
  for (const key of Object.keys(cost)) {
    const match = CONTEXT_TIER_KEY_RE.exec(key);
    if (!match) {
      continue;
    }
    const tier = (cost as Record<string, AvailableModelCostTier | undefined>)[
      key
    ];
    if (
      typeof tier?.input !== "number" &&
      typeof tier?.output !== "number"
    ) {
      continue;
    }
    const thresholdTokens = Number(match[1]) * 1000;
    if (
      usage.inputTokens > thresholdTokens &&
      thresholdTokens > winningThresholdTokens
    ) {
      winningThresholdTokens = thresholdTokens;
      winningTier = tier;
    }
  }

  if (!winningTier) {
    return cost;
  }

  return {
    input: winningTier.input ?? cost.input,
    output: winningTier.output ?? cost.output,
    cache_read: winningTier.cache_read ?? cost.cache_read,
    cache_write: winningTier.cache_write ?? cost.cache_write,
  };
}

export function estimateModelUsageCost(
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    /**
     * Tokens newly written to the prompt cache this step (e.g. Anthropic's
     * `cache_creation_input_tokens`). Optional -- most providers/models
     * don't report or charge for this separately.
     */
    cacheWriteInputTokens?: number;
    outputTokens: number;
  },
  cost: AvailableModelCost | undefined,
): number | undefined {
  const costTier = resolveCostTier(usage, cost);
  const inputPrice = costTier?.input;
  const outputPrice = costTier?.output;
  if (typeof inputPrice !== "number" || typeof outputPrice !== "number") {
    return undefined;
  }

  const cacheWriteInputTokens = Math.max(0, usage.cacheWriteInputTokens ?? 0);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens);
  // inputTokens is the *total* prompt size, which already includes both
  // the cache-read and cache-write portions -- subtract both so the
  // remaining "uncached" bucket isn't double-billed at the full rate.
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - cachedInputTokens - cacheWriteInputTokens,
  );
  const cacheReadPrice = costTier?.cache_read ?? inputPrice;
  const cacheWritePrice = costTier?.cache_write ?? inputPrice;

  return (
    (uncachedInputTokens * inputPrice) / TOKENS_PER_MILLION +
    (cachedInputTokens * cacheReadPrice) / TOKENS_PER_MILLION +
    (cacheWriteInputTokens * cacheWritePrice) / TOKENS_PER_MILLION +
    (Math.max(0, usage.outputTokens) * outputPrice) / TOKENS_PER_MILLION
  );
}
