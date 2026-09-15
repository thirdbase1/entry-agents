import { describe, test, expect } from "bun:test";
import { shouldDowngradeOnSubscriptionDisable } from "./plans";

/**
 * Policy tests for the subscription.disable webhook (added 2026-09-15
 * after the owner noticed lapsed subscribers never reverted to Free).
 * Pure policy -- the DB side of downgradeToFreeOnSubscriptionEnd lives
 * in credit-ledger (server-only import breaks bun tests, same
 * arrangement as findExceededUsageWindow).
 */
describe("shouldDowngradeOnSubscriptionDisable", () => {
  test("paid plan + matching code -> downgrade", () => {
    expect(shouldDowngradeOnSubscriptionDisable("plus", "SUB_77", "SUB_77")).toBe(true);
    expect(shouldDowngradeOnSubscriptionDisable("goat", "SUB_77", "SUB_77")).toBe(true);
  });

  test("disable for an OLD subscription never kicks a re-subscribed user", () => {
    expect(shouldDowngradeOnSubscriptionDisable("goat", "SUB_NEW", "SUB_OLD")).toBe(false);
  });

  test("already-free user -> no-op (repeat webhook delivery)", () => {
    expect(shouldDowngradeOnSubscriptionDisable("free", "SUB_77", "SUB_77")).toBe(false);
  });

  test("no plan on record -> no-op", () => {
    expect(shouldDowngradeOnSubscriptionDisable(null, "SUB_77", "SUB_77")).toBe(false);
    expect(shouldDowngradeOnSubscriptionDisable(undefined, "SUB_77", "SUB_77")).toBe(false);
  });

  test("user has no stored subscription code -> no-op (never Paystack-subscribed)", () => {
    expect(shouldDowngradeOnSubscriptionDisable("plus", null, "SUB_77")).toBe(false);
    expect(shouldDowngradeOnSubscriptionDisable("plus", undefined, "SUB_77")).toBe(false);
  });
});
