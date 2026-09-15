import { describe, expect, test } from "bun:test";

import {
  findExceededUsageWindow,
  PLAN_CATALOG,
  type UsageWindowTotals,
} from "@/lib/billing/plans";

const ZERO_TOTALS: UsageWindowTotals = {
  last5HoursCents: 0,
  last7DaysCents: 0,
  last30DaysCents: 0,
};

describe("findExceededUsageWindow", () => {
  const windows = PLAN_CATALOG.goat.usageWindows!;

  test("returns null when all windows are under their limits", () => {
    expect(
      findExceededUsageWindow(
        {
          last5HoursCents: windows.fiveHourLimitCents - 1,
          last7DaysCents: windows.weeklyLimitCents - 1,
          last30DaysCents: windows.monthlyLimitCents - 1,
        },
        windows,
      ),
    ).toBeNull();
  });

  test("flags the 5-hour window at exactly its limit", () => {
    expect(
      findExceededUsageWindow(
        {
          ...ZERO_TOTALS,
          last5HoursCents: windows.fiveHourLimitCents,
        },
        windows,
      ),
    ).toBe("fiveHour");
  });

  test("5-hour wins over weekly/monthly when several are full (nearest reset first)", () => {
    expect(
      findExceededUsageWindow(
        {
          last5HoursCents: windows.fiveHourLimitCents,
          last7DaysCents: windows.weeklyLimitCents,
          last30DaysCents: windows.monthlyLimitCents,
        },
        windows,
      ),
    ).toBe("fiveHour");
  });

  test("flags weekly only when 5-hour is not full", () => {
    expect(
      findExceededUsageWindow(
        {
          ...ZERO_TOTALS,
          last5HoursCents: windows.fiveHourLimitCents - 1,
          last7DaysCents: windows.weeklyLimitCents,
        },
        windows,
      ),
    ).toBe("weekly");
  });

  test("flags monthly only when 5-hour and weekly are not full", () => {
    expect(
      findExceededUsageWindow(
        {
          ...ZERO_TOTALS,
          last7DaysCents: windows.weeklyLimitCents - 1,
          last30DaysCents: windows.monthlyLimitCents,
        },
        windows,
      ),
    ).toBe("monthly");
  });

  test("GOAT windows are 20%/50%/100% of the $50 grant", () => {
    expect(windows.fiveHourLimitCents).toBe(1000);
    expect(windows.weeklyLimitCents).toBe(2500);
    expect(windows.monthlyLimitCents).toBe(5000);
  });

  test("only the GOAT plan has usage windows", () => {
    for (const [planId, plan] of Object.entries(PLAN_CATALOG)) {
      if (planId === "goat") {
        expect(plan.usageWindows).toBeDefined();
      } else {
        expect(plan.usageWindows).toBeUndefined();
      }
    }
  });
});
