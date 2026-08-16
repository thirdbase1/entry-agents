export const DEFAULT_MODEL_ID = "deepseek-v4-flash"; // TEMP: ling-3.0-flash-free is down on Opencode Zen (503 "Endpoint is unavailable", confirmed 2026-08-11). Revert once Opencode Zen restores it.
export const APP_DEFAULT_MODEL_ID = "deepseek-v4-flash"; // TEMP: same outage, see DEFAULT_MODEL_ID above.
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

function resolveCostTier(
  usage: { inputTokens: number },
  cost: AvailableModelCost | undefined,
): AvailableModelCostTier | undefined {
  if (!cost) {
    return undefined;
  }

  if (
    usage.inputTokens > 200_000 &&
    (typeof cost.context_over_200k?.input === "number" ||
      typeof cost.context_over_200k?.output === "number")
  ) {
    return {
      input: cost.context_over_200k.input ?? cost.input,
      output: cost.context_over_200k.output ?? cost.output,
      cache_read: cost.context_over_200k.cache_read ?? cost.cache_read,
      cache_write: cost.context_over_200k.cache_write ?? cost.cache_write,
    };
  }

  return cost;
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
