import { describe, expect, test } from "bun:test";
import { estimateStepCost } from "./gateway-metadata";

const catalog = [
  {
    id: "test-model",
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    },
  },
];

describe("estimateStepCost cache accounting", () => {
  test("reads cacheReadTokens/cacheWriteTokens from inputTokenDetails (current AI SDK shape)", () => {
    // 50k uncached + 20k cache-write + 30k cache-read + 1k output.
    // (50_000*3 + 30_000*0.3 + 20_000*3.75 + 1_000*15) / 1e6 = 0.24
    const cost = estimateStepCost(
      undefined,
      "test-model",
      {
        inputTokens: 100_000,
        outputTokens: 1_000,
        inputTokenDetails: {
          cacheReadTokens: 30_000,
          cacheWriteTokens: 20_000,
        },
      },
      catalog,
    );
    expect(cost).toBeCloseTo(0.249, 6);
  });

  test("does not silently zero out the cache discount when inputTokenDetails is absent (deprecated fallback)", () => {
    // Older-shaped usage object with only the deprecated flat field --
    // should still apply the cache-read discount via the fallback.
    // (80_000*3 + 20_000*0.3 + 1_000*15) / 1e6 = 0.261
    const cost = estimateStepCost(
      undefined,
      "test-model",
      {
        inputTokens: 100_000,
        outputTokens: 1_000,
        cachedInputTokens: 20_000,
      },
      catalog,
    );
    expect(cost).toBeCloseTo(0.261, 6);
  });

  test("prefers inputTokenDetails over the deprecated flat field when both are present", () => {
    // inputTokenDetails says 40k cached; the stale deprecated field says 0 --
    // the current field should win, not the deprecated one.
    // (60_000*3 + 40_000*0.3 + 1_000*15) / 1e6 = 0.207
    const cost = estimateStepCost(
      undefined,
      "test-model",
      {
        inputTokens: 100_000,
        outputTokens: 1_000,
        cachedInputTokens: 0,
        inputTokenDetails: {
          cacheReadTokens: 40_000,
          cacheWriteTokens: 0,
        },
      },
      catalog,
    );
    expect(cost).toBeCloseTo(0.207, 6);
  });

  test("returns undefined when there's no usage and no gateway-reported cost", () => {
    const cost = estimateStepCost(undefined, "test-model", undefined, catalog);
    expect(cost).toBeUndefined();
  });
});
