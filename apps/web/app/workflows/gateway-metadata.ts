import type { ProviderMetadata } from "ai";
import { estimateModelUsageCost, type AvailableModelCost } from "@/lib/models";

/**
 * Shape of the (legacy) Vercel AI Gateway entry in `providerMetadata`.
 * Kept only for backward compatibility -- our current shared provider is
 * Entry's own entry-gateway (self-hosted on Pxxl), which does not emit
 * this shape. Real cost accounting now comes from `estimateStepCost`
 * below, using the static per-model pricing table fetched live from
 * entry-gateway's /v1/models.
 */
export interface GatewayProviderMetadata {
  gateway: {
    cost?: string;
    marketCost?: string;
    inferenceCost?: string;
    inputInferenceCost?: string;
    outputInferenceCost?: string;
    generationId?: string;
  };
}

function hasGatewayShape(
  metadata: ProviderMetadata | undefined,
): metadata is ProviderMetadata & GatewayProviderMetadata {
  if (!metadata) {
    return false;
  }
  const gateway = (metadata as Record<string, unknown>).gateway;
  return typeof gateway === "object" && gateway !== null;
}

/**
 * Extract the gateway-reported cost for a single step (legacy Vercel AI
 * Gateway shape only). Returns `undefined` for any other provider,
 * including our current shared provider -- that's expected, and
 * `estimateStepCost` below is what actually prices real requests now.
 */
export function extractGatewayCost(
  providerMetadata: ProviderMetadata | undefined,
): number | undefined {
  if (!hasGatewayShape(providerMetadata)) {
    return undefined;
  }
  const rawCost = providerMetadata.gateway.cost;
  if (typeof rawCost !== "string") {
    return undefined;
  }
  const cost = Number.parseFloat(rawCost);
  return Number.isFinite(cost) ? cost : undefined;
}

export interface CatalogCostEntry {
  id: string;
  cost?: AvailableModelCost;
}

/**
 * Combined cost estimate for a single step: prefers the legacy
 * gateway-reported cost when present, otherwise computes cost from the
 * static per-model pricing table (fetched live from entry-gateway's
 * /v1/models) plus the step's real token usage. This is what actually
 * prices every real request today.
 */
export function estimateStepCost(
  providerMetadata: ProviderMetadata | undefined,
  modelId: string,
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
        /**
         * @deprecated Use inputTokenDetails.cacheReadTokens instead --
         * kept only as a fallback for usage objects that predate the
         * inputTokenDetails split (some provider adapters/tests still
         * only populate this one).
         */
        cachedInputTokens?: number;
      }
    | undefined,
  catalog: CatalogCostEntry[],
): number | undefined {
  const gatewayCost = extractGatewayCost(providerMetadata);
  if (gatewayCost !== undefined) {
    return gatewayCost;
  }

  if (!usage) {
    return undefined;
  }

  const model = catalog.find((m) => m.id === modelId);
  if (!model?.cost) {
    return undefined;
  }

  // The AI SDK moved cache accounting from the flat, now-deprecated
  // `cachedInputTokens` field into `inputTokenDetails.cacheReadTokens` /
  // `cacheWriteTokens`. Current provider adapters generally only populate
  // the new nested fields, so reading the deprecated one exclusively (as
  // this used to do) silently always came out to 0 -- meaning the cache
  // discount (and any cache-write surcharge) never applied and every
  // message was billed as if 100% of its input was uncached. Prefer the
  // current field, fall back to the deprecated one for older callers.
  const cachedInputTokens =
    usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

  return estimateModelUsageCost(
    {
      inputTokens: usage.inputTokens ?? 0,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens: usage.outputTokens ?? 0,
    },
    model.cost,
  );
}
