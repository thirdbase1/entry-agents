import { describe, test, expect } from "bun:test";
import {
  applySpendToBudgets,
  buildSubagentBudgetGuard,
  computeAffordableOutputTokens,
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
    expect(estimateNextStepInputTokens(usage(10_000), () => 5_000)).toBe(12_000);
  });

  test("first step falls back to chars/4 + 8k overhead", () => {
    expect(estimateNextStepInputTokens(undefined, () => 40_000)).toBe(18_000);
  });

  test("char-count getter is LAZY -- never invoked when last step usage exists (perf)", () => {
    let calls = 0;
    const result = estimateNextStepInputTokens(usage(10_000), () => {
      calls += 1;
      return 999_999;
    });
    expect(result).toBe(12_000);
    expect(calls).toBe(0);
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

describe("computeAffordableOutputTokens", () => {
  test("blocks when budget is fully spent", () => {
    const r = computeAffordableOutputTokens(0, COST);
    expect(r.stop).toBe(true);
  });

  test("blocks with expensive output pricing even at 1c", () => {
    // $60/M output: 1c -> floor(1*.98/.006) = 163 < 200 tokens.
    const pricey: AvailableModelCost = { ...COST, output: 60 };
    const r = computeAffordableOutputTokens(1, pricey);
    expect(r.stop).toBe(true);
  });

  test("clamps mid-range budgets", () => {
    // 5c at $6/M output = 0.0006c/token -> floor(5*0.98/0.0006) = 8166
    const r = computeAffordableOutputTokens(5, COST);
    expect(r.stop).toBe(false);
    expect(r.maxOutputTokens).toBe(8_166);
  });

  test("comfortable budget -> no clamp", () => {
    const r = computeAffordableOutputTokens(100_000, COST);
    expect(r.stop).toBe(false);
    expect(r.maxOutputTokens).toBeUndefined();
  });

  test("unknown pricing -> no enforcement", () => {
    expect(computeAffordableOutputTokens(5, undefined).stop).toBe(false);
  });
});

describe("applySpendToBudgets", () => {
  test("decrements both budgets and reports the binding exhaustion reason", () => {
    const state = applySpendToBudgets({
      remainingWindowBudgetCents: 3,
      remainingBalanceCents: 1_000,
      enforceCreditBlock: true,
      costCents: 5,
    });
    expect(state.remainingWindowBudgetCents).toBe(-2);
    expect(state.remainingBalanceCents).toBe(995);
    expect(state.exhaustedReason).toBe("window");
  });

  test("credit binds when balance is lower than the window", () => {
    const state = applySpendToBudgets({
      remainingWindowBudgetCents: 50,
      remainingBalanceCents: 2,
      enforceCreditBlock: true,
      costCents: 5,
    });
    expect(state.exhaustedReason).toBe("credit");
  });

  test("no exhaustion when budgets remain", () => {
    const state = applySpendToBudgets({
      remainingWindowBudgetCents: 100,
      remainingBalanceCents: 100,
      enforceCreditBlock: true,
      costCents: 5,
    });
    expect(state.exhaustedReason).toBeNull();
  });

  test("non-windowed admin: only balance applies (and skips when not enforced)", () => {
    const state = applySpendToBudgets({
      remainingWindowBudgetCents: null,
      remainingBalanceCents: 1_000,
      enforceCreditBlock: false,
      costCents: 5,
    });
    expect(state.remainingWindowBudgetCents).toBeNull();
    expect(state.remainingBalanceCents).toBe(1_000);
    expect(state.exhaustedReason).toBeNull();
  });
});

describe("buildSubagentBudgetGuard", () => {
  function makeCallbacks(init: {
    windowBudget: number | null;
    balance: number;
    enforceCreditBlock?: boolean;
  }) {
    let windowBudget = init.windowBudget;
    let balance = init.balance;
    const enforceCreditBlock = init.enforceCreditBlock ?? true;
    const cb = {
      getWindowRemainingCents: () => windowBudget,
      getBalanceRemainingCents: () => balance,
      getEnforceCreditBlock: () => enforceCreditBlock,
      spendCents: (costCents: number) => {
        const state = applySpendToBudgets({
          remainingWindowBudgetCents: windowBudget,
          remainingBalanceCents: balance,
          enforceCreditBlock,
          costCents,
        });
        windowBudget = state.remainingWindowBudgetCents;
        balance = state.remainingBalanceCents;
        return state;
      },
      getCost: () => COST,
    };
    return { cb, spy: () => ({ windowBudget, balance }) };
  }

  test("planSubagent stops when the budget is fully spent", () => {
    const { cb } = makeCallbacks({ windowBudget: 0, balance: 1_000 });
    const guard = buildSubagentBudgetGuard(cb);
    const plan = guard.planSubagent("qwen3.8-max");
    expect(plan.stop).toBe(true);
    expect(plan.reason).toBe("window");
  });

  test("planSubagent clamps output for a windowed user with a mid-size budget", () => {
    // 20c at $6/M -> floor(20*.98/.0006) = 32666 < 32768 -> clamp
    const { cb } = makeCallbacks({ windowBudget: 20, balance: 1_000 });
    const guard = buildSubagentBudgetGuard(cb);
    const plan = guard.planSubagent("qwen3.8-max");
    expect(plan.stop).toBe(false);
    expect(plan.maxOutputTokens).toBe(32_666);
  });

  test("planSubagent is a no-op for non-windowed admins without credit block", () => {
    const { cb } = makeCallbacks({
      windowBudget: null,
      balance: 1_000,
      enforceCreditBlock: false,
    });
    const guard = buildSubagentBudgetGuard(cb);
    expect(guard.planSubagent("qwen3.8-max")).toEqual({ stop: false });
  });

  test("noteSubagentStepUsage decrements the shared budget and stops on exhaustion", () => {
    // 10k uncached input + 100 output at $2/$6 per M = $0.0206 -> 2c.
    // 2c left: the first subagent step drains it exactly to 0.
    const { cb, spy } = makeCallbacks({ windowBudget: 2, balance: 1_000 });
    const guard = buildSubagentBudgetGuard(cb);
    const first = guard.noteSubagentStepUsage("qwen3.8-max", usage(10_000));
    expect(spy().windowBudget).toBe(0);
    expect(first.stop).toBe(true);
    expect(first.reason).toBe("window");
  });

  test("noteSubagentStepUsage keeps running while budget remains", () => {
    const { cb, spy } = makeCallbacks({ windowBudget: 1_000, balance: 10_000 });
    const guard = buildSubagentBudgetGuard(cb);
    const first = guard.noteSubagentStepUsage("qwen3.8-max", usage(10_000));
    expect(spy().windowBudget).toBe(998);
    expect(first.stop).toBe(false);
  });

  test("noteSubagentStepUsage is a no-op without budgets", () => {
    const { cb } = makeCallbacks({
      windowBudget: null,
      balance: 1_000,
      enforceCreditBlock: false,
    });
    const guard = buildSubagentBudgetGuard(cb);
    expect(guard.noteSubagentStepUsage("qwen3.8-max", usage(50_000))).toEqual({
      stop: false,
    });
  });
});
