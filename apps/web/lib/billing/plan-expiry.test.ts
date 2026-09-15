import { describe, test, expect } from "bun:test";
import {
  shouldAutoRevertToFree,
  PLAN_EXPIRY_GRACE_MS,
} from "./plans";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-15T12:00:00Z");

describe("shouldAutoRevertToFree (own expiry enforcement, no Paystack reliance)", () => {
  test("paid plan whose last renewal is older than the grace -> revert", () => {
    expect(shouldAutoRevertToFree("plus", new Date(NOW - 36 * DAY), NOW)).toBe(true);
    expect(shouldAutoRevertToFree("goat", new Date(NOW - 40 * DAY), NOW)).toBe(true);
    expect(shouldAutoRevertToFree("max", new Date(NOW - PLAN_EXPIRY_GRACE_MS - 1), NOW)).toBe(true);
  });

  test("healthy monthly subscriber (anchor < 31 days) -> keep", () => {
    expect(shouldAutoRevertToFree("plus", new Date(NOW - 30 * DAY), NOW)).toBe(false);
    expect(shouldAutoRevertToFree("max", new Date(NOW - 2 * DAY), NOW)).toBe(false);
  });

  test("exactly at the grace boundary -> NOT reverted (strictly greater)", () => {
    expect(shouldAutoRevertToFree("plus", new Date(NOW - PLAN_EXPIRY_GRACE_MS), NOW)).toBe(false);
  });

  test("free plan never reverts", () => {
    expect(shouldAutoRevertToFree("free", new Date(NOW - 90 * DAY), NOW)).toBe(false);
    expect(shouldAutoRevertToFree(null, new Date(NOW - 90 * DAY), NOW)).toBe(false);
  });

  test("null anchor -> no-op (never saw a renewal charge; can't interpret)", () => {
    expect(shouldAutoRevertToFree("plus", null, NOW)).toBe(false);
    expect(shouldAutoRevertToFree("goat", undefined, NOW)).toBe(false);
  });

  test("unparseable anchor -> no-op, never crash", () => {
    expect(shouldAutoRevertToFree("plus", "not-a-date", NOW)).toBe(false);
  });
});

import {
  consumedFromGrantPool,
  expiredGrantCentsOnPlanEnd,
} from "./plans";

describe("grant pool: consumption + expiry math (credit dies with the plan)", () => {
  test("usage consumes the pool first, capped at the pool", () => {
    expect(consumedFromGrantPool(300, 5000)).toBe(300);
    expect(consumedFromGrantPool(5000, 300)).toBe(300);
    expect(consumedFromGrantPool(5000, 5000)).toBe(5000);
  });

  test("zero cost or empty pool -> nothing consumed", () => {
    expect(consumedFromGrantPool(0, 5000)).toBe(0);
    expect(consumedFromGrantPool(300, 0)).toBe(0);
    expect(consumedFromGrantPool(-5, 5000)).toBe(0);
  });

  test("on plan end: the unspent grant is removed", () => {
    expect(expiredGrantCentsOnPlanEnd(4200, 1000)).toBe(1000);
  });

  test("on plan end: never remove more than the balance (negative-balance defense)", () => {
    expect(expiredGrantCentsOnPlanEnd(50, 1000)).toBe(50);
    expect(expiredGrantCentsOnPlanEnd(0, 1000)).toBe(0);
    expect(expiredGrantCentsOnPlanEnd(-200, 1000)).toBe(0);
  });

  test("on plan end: pure top-up user (empty pool) keeps everything", () => {
    expect(expiredGrantCentsOnPlanEnd(4200, 0)).toBe(0);
  });
});
