import { describe, expect, test } from "bun:test";
import { estimateModelUsageCost } from "./models";

describe("estimateModelUsageCost", () => {
  test("uses base pricing below the 200k context threshold", () => {
    expect(
      estimateModelUsageCost(
        {
          inputTokens: 100_000,
          cachedInputTokens: 80_000,
          outputTokens: 1_000,
        },
        {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
      ),
    ).toBeCloseTo(0.085, 6);
  });

  test("uses context-over-200k pricing when the prompt exceeds the threshold", () => {
    expect(
      estimateModelUsageCost(
        {
          inputTokens: 250_000,
          cachedInputTokens: 200_000,
          outputTokens: 1_000,
        },
        {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
      ),
    ).toBeCloseTo(0.3725, 6);
  });
});

describe("estimateModelUsageCost cache-write pricing", () => {
  test("bills cache-write tokens at cache_write rate when the model publishes one", () => {
    // 50k regular input + 20k cache write + 30k cache read + 1k output.
    // (50_000 * 3 + 30_000 * 0.3 + 20_000 * 3.75 + 1_000 * 15) / 1e6 = 0.249
    expect(
      estimateModelUsageCost(
        {
          inputTokens: 100_000,
          cachedInputTokens: 30_000,
          cacheWriteInputTokens: 20_000,
          outputTokens: 1_000,
        },
        {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
      ),
    ).toBeCloseTo(0.249, 6);
  });

  test("falls back to the base input rate for cache-write tokens when no cache_write price is set", () => {
    // No cache_write price -> billed at the base input rate: 100_000 * 2 / 1e6 = 0.2
    expect(
      estimateModelUsageCost(
        {
          inputTokens: 100_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 20_000,
          outputTokens: 0,
        },
        {
          input: 2,
          output: 6,
          cache_read: 0.3,
        },
      ),
    ).toBeCloseTo(0.2, 6);
  });
});
