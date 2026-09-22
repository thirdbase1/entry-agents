import { describe, expect, test } from "bun:test";

import { formatUsd, formatUsdCents } from "@/lib/format-usd";

describe("formatUsdCents", () => {
  test("always keeps the cents column, so exact whole dollars are not read as rounded", () => {
    // Regression: the sidebar used `minimumFractionDigits: cents % 100 === 0 ? 0 : 2`,
    // which rendered a 100-cent balance as "$1" and dropped cents entirely.
    expect(formatUsdCents(100)).toBe("$1.00");
    expect(formatUsdCents(1000)).toBe("$10.00");
    expect(formatUsdCents(100_000)).toBe("$1,000.00");
  });

  test("renders cents exactly, never rounding them away", () => {
    expect(formatUsdCents(0)).toBe("$0.00");
    expect(formatUsdCents(1)).toBe("$0.01");
    expect(formatUsdCents(5)).toBe("$0.05");
    expect(formatUsdCents(50)).toBe("$0.50");
    expect(formatUsdCents(99)).toBe("$0.99");
    expect(formatUsdCents(101)).toBe("$1.01");
    expect(formatUsdCents(383)).toBe("$3.83");
  });

  test("groups thousands so a large balance stays scannable", () => {
    expect(formatUsdCents(123_456)).toBe("$1,234.56");
  });

  test("survives a non-finite value instead of printing NaN", () => {
    expect(formatUsdCents(Number.NaN)).not.toContain("NaN");
    expect(formatUsdCents(Number.POSITIVE_INFINITY)).not.toContain("NaN");
  });
});

describe("formatUsd", () => {
  test("uses four decimals below a dollar so sub-cent costs stay legible", () => {
    // A per-message model cost of $0.004 and $0.00 are indistinguishable
    // at two decimals; that is the whole point of the extra precision.
    expect(formatUsd(0.004)).toBe("$0.0040");
    expect(formatUsd(0.001)).toBe("$0.0010");
    expect(formatUsd(0.0001)).toBe("$0.0001");
    expect(formatUsd(0.5)).toBe("$0.5000");
  });

  test("switches to two decimals at a dollar and above", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(1.00383)).toBe("$1.00");
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  test("zero is two decimals, not four", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  test("groups thousands", () => {
    expect(formatUsd(1500)).toBe("$1,500.00");
  });

  test("survives a non-finite value instead of printing NaN", () => {
    expect(formatUsd(Number.NaN)).not.toContain("NaN");
  });
});
