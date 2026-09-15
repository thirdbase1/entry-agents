import { describe, test, expect } from "bun:test";
import {
  computeRealtimeSpendCap,
  estimateNextStepInputTokens,
} from "./realtime-spend-cap";
import type { AvailableModelCost } from "@/lib/models";

// $2/M input, $6/M output, $0.25/M cache read (official Qwen3.8-Max
// pricing -- realistic for the models behind the gateway).
const COST: AvailableModelCost = {
  input: 2,
  output: 6,
  cache_read: 0.25,
  cache_write: 2,
};

const usage = (input: number, cacheRead = 0) =>
  ({
    inputTokens: input,
    cachedInputTokens: 0, // deprecated field: adapters leave it at 0
    inputTokenDetails: { cacheReadTokens: cacheRead },
    outputTokens: 100,
    totalTokens: input + 100,
    outputTokenDetails: {},
  }) as any;

describe("estimateNextStepInputTokens", () => {
  test("uses last step's real input grown 20%", () => {
    expect(estimateNextStepInputTokens(usage(10_000), 5_000)).toBe(12_000);
  });

  test("first step falls back to chars/4 + 8k overhead", () => {
    expect(estimateNextStepInputTokens(undefined, 40_000)).toBe(18_000);
  });
});

describe("computeRealtimeSpendCap", () => {
  test("no budgets (non-windowed admin) -> never blocks or clamps", () => {
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: null,
      remainingBalanceCents: 1000,
      enforceCreditBlock: false,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000),
      cost: COST,
    });
    expect(cap.blockReason).toBeNull();
    expect(cap.maxOutputTokens).toBeUndefined();
  });

  test("unknown pricing -> reactive-only, no block/clamp", () => {
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: 100,
      remainingBalanceCents: 10_000,
      enforceCreditBlock: true,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000),
      cost: undefined,
    });
    expect(cap.blockReason).toBeNull();
  });

  test("input alone unaffordable -> block on the binding budget (window)", () => {
    // 50k uncached input at $2/M = $0.10 = 10 cents > 8 cents remaining.
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: 8,
      remainingBalanceCents: 5_000,
      enforceCreditBlock: true,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000),
      cost: COST,
    });
    expect(cap.blockReason).toBe("window");
  });

  test("balance binding -> block reason says credit (top-up wording)", () => {
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: 9_000,
      remainingBalanceCents: 5,
      enforceCreditBlock: true,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000),
      cost: COST,
    });
    expect(cap.blockReason).toBe("credit");
  });

  test("tight budget -> output clamp makes worst-case output fit", () => {
    // Remaining $0.05 (5c). Input 50k with 90% cache read costs ~2c
    // (5k uncached @$2/M + 45k cached @$0.25/M). ~3c left for output at
    // $6/M = 0.0006c/token -> floor(3 * 0.98 / 0.0006) = 4900 tokens.
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: 5,
      remainingBalanceCents: 1_000_000,
      enforceCreditBlock: true,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000, 45_000),
      cost: COST,
    });
    expect(cap.blockReason).toBeNull();
    expect(cap.maxOutputTokens).toBeDefined();
    expect(cap.maxOutputTokens!).toBeGreaterThan(4_500);
    expect(cap.maxOutputTokens!).toBeLessThan(5_100);
  });

  test("comfortable budget -> no clamp at all", () => {
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: 100_000, // $1000
      remainingBalanceCents: 100_000,
      enforceCreditBlock: true,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000),
      cost: COST,
    });
    expect(cap.blockReason).toBeNull();
    expect(cap.maxOutputTokens).toBeUndefined();
  });

  test("affordable output below useful minimum -> block instead of truncating", () => {
    // $0.01 left, input fully cached (free-ish) -> ~163 output tokens < 200.
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: 1,
      remainingBalanceCents: 1_000,
      enforceCreditBlock: true,
      estimatedInputTokens: 50_000,
      lastStepUsage: usage(50_000, 50_000),
      cost: COST,
    });
    expect(cap.blockReason).toBe("window");
  });

  test("free-tier balance-only user gets the clamp too", () => {
    // No window; enforceCreditBlock with $0.20 balance.
    const cap = computeRealtimeSpendCap({
      remainingWindowBudgetCents: null,
      remainingBalanceCents: 20,
      enforceCreditBlock: true,
      estimatedInputTokens: 10_000,
      lastStepUsage: usage(10_000),
      cost: COST,
    });
    expect(cap.blockReason).toBeNull();
    expect(cap.maxOutputTokens).toBeDefined();
    expect(cap.maxOutputTokens!).toBeGreaterThan(200);
  });
});
