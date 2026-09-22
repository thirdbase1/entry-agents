import { describe, expect, test } from "bun:test";

import {
  accruedCostCents,
  settleStepCost,
  type UsageAccrualState,
} from "@/lib/billing/usage-accrual";

describe("settleStepCost", () => {
  test("a sub-cent step settles nothing but keeps its cost pending", () => {
    // The exact regression: this used to be Math.round(0.4) = 0 and the
    // cost was dropped on the floor -- free usage.
    const state: UsageAccrualState = { carryCents: 0 };
    expect(settleStepCost(state, 0.004)).toBe(0);
    expect(accruedCostCents(state)).toBe(0.4);
  });

  test("ten cheap steps bill their exact 4 cents, not zero", () => {
    const state: UsageAccrualState = { carryCents: 0 };
    let billed = 0;
    for (let i = 0; i < 10; i++) {
      billed += settleStepCost(state, 0.004);
    }
    expect(billed).toBe(4);
    expect(accruedCostCents(state)).toBe(0);
  });

  test("carry never loses the remainder across many uneven steps", () => {
    const state: UsageAccrualState = { carryCents: 0 };
    let billed = 0;
    const costs = [0.001, 0.0021, 0.0004, 0.0077, 0.0033, 0.0009];
    for (const cost of costs) {
      billed += settleStepCost(state, cost);
    }
    const trueTotalCents = costs.reduce((sum, c) => sum + c, 0) * 100;
    // Billed so far plus what is still pending must equal the real total
    // exactly -- that is the "loses nothing" property.
    expect(billed + accruedCostCents(state)).toBeCloseTo(trueTotalCents, 10);
    expect(billed).toBeGreaterThan(0);
  });

  test("a whole-cent step settles immediately", () => {
    const state: UsageAccrualState = { carryCents: 0 };
    expect(settleStepCost(state, 0.05)).toBe(5);
    expect(accruedCostCents(state)).toBe(0);
  });

  test("carry rolls into the next step instead of being discarded", () => {
    const state: UsageAccrualState = { carryCents: 0 };
    settleStepCost(state, 0.007); // 0.7c pending
    settleStepCost(state, 0.006); // 1.3c pending -> 1c bills
    expect(accruedCostCents(state)).toBeCloseTo(0.3, 10);
  });

  test("zero and non-finite costs are inert", () => {
    const state: UsageAccrualState = { carryCents: 0 };
    expect(settleStepCost(state, 0)).toBe(0);
    expect(settleStepCost(state, Number.NaN)).toBe(0);
    expect(settleStepCost(state, Number.POSITIVE_INFINITY)).toBe(0);
    expect(accruedCostCents(state)).toBe(0);
  });

  test("float dust does not round a cent away", () => {
    // 0.0033 * 3 is exactly 0.99 cents mathematically, but in float64
    // the sum lands at 0.9899999999999999. Without the round6() guard
    // that dust is what a naive Math.floor can be off by; here the true
    // total is under a cent, so 0 is the correct answer either way.
    const state: UsageAccrualState = { carryCents: 0 };
    let billed = 0;
    for (let i = 0; i < 3; i++) {
      billed += settleStepCost(state, 0.0033);
    }
    expect(billed).toBe(0);
    expect(accruedCostCents(state)).toBeCloseTo(0.99, 10);
  });

  test("a boundary case sitting exactly on 1 cent does bill", () => {
    // 0.0034 * 3 = 1.02 cents in float, comfortably over the line, so
    // one whole cent must settle and the rest must stay pending.
    const state: UsageAccrualState = { carryCents: 0 };
    let billed = 0;
    for (let i = 0; i < 3; i++) {
      billed += settleStepCost(state, 0.0034);
    }
    expect(billed).toBe(1);
    expect(accruedCostCents(state)).toBeCloseTo(0.02, 10);
  });

  test("a large step bills its whole cents and keeps only the fraction", () => {
    const state: UsageAccrualState = { carryCents: 0 };
    expect(settleStepCost(state, 1.00383)).toBe(100);
    expect(accruedCostCents(state)).toBeCloseTo(0.383, 10);
  });
});
