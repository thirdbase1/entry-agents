import { describe, expect, test } from "bun:test";
import {
  type BenchmarkResultRow,
  summarizeBenchmarkResultRows,
} from "./benchmarks";

function row(overrides: Partial<BenchmarkResultRow>): BenchmarkResultRow {
  return {
    modelId: "gpt-5.6-luna",
    benchmark: "humaneval",
    passed: true,
    latencyMs: 1000,
    costMicros: 10_000,
    ...overrides,
  };
}

describe("summarizeBenchmarkResultRows", () => {
  test("returns an empty array for no rows", () => {
    expect(summarizeBenchmarkResultRows([])).toEqual([]);
  });

  test("aggregates pass/total per model per benchmark", () => {
    const rows: BenchmarkResultRow[] = [
      row({ modelId: "a", passed: true }),
      row({ modelId: "a", passed: false }),
      row({ modelId: "a", passed: true }),
      row({ modelId: "b", passed: true }),
    ];

    const summary = summarizeBenchmarkResultRows(rows);
    const a = summary.find((m) => m.modelId === "a");
    const b = summary.find((m) => m.modelId === "b");

    expect(a?.results.humaneval).toEqual({ passed: 2, total: 3 });
    expect(b?.results.humaneval).toEqual({ passed: 1, total: 1 });
  });

  test("keeps separate benchmark buckets for the same model", () => {
    const rows: BenchmarkResultRow[] = [
      row({ modelId: "a", benchmark: "humaneval", passed: true }),
      row({ modelId: "a", benchmark: "swebench_verified", passed: false }),
    ];

    const summary = summarizeBenchmarkResultRows(rows);
    const a = summary.find((m) => m.modelId === "a");

    expect(a?.results.humaneval).toEqual({ passed: 1, total: 1 });
    expect(a?.results.swebench_verified).toEqual({ passed: 0, total: 1 });
    expect(a?.results.entry_tasks).toBeUndefined();
  });

  test("computes avg latency only over rows that have a latency value", () => {
    const rows: BenchmarkResultRow[] = [
      row({ modelId: "a", latencyMs: 1000 }),
      row({ modelId: "a", latencyMs: 3000 }),
      row({ modelId: "a", latencyMs: null }),
    ];

    const summary = summarizeBenchmarkResultRows(rows);
    const a = summary.find((m) => m.modelId === "a");

    expect(a?.avgLatencyMs).toBe(2000);
  });

  test("returns null avg latency when no row has a latency value", () => {
    const rows: BenchmarkResultRow[] = [row({ modelId: "a", latencyMs: null })];
    const summary = summarizeBenchmarkResultRows(rows);
    expect(summary[0].avgLatencyMs).toBeNull();
  });

  test("sums cost across all rows for a model, treating null as zero", () => {
    const rows: BenchmarkResultRow[] = [
      row({ modelId: "a", costMicros: 50_000 }),
      row({ modelId: "a", costCents: null }),
      row({ modelId: "a", costMicros: 30_000 }),
    ];

    const summary = summarizeBenchmarkResultRows(rows);
    expect(summary[0].totalCostMicros).toBe(80_000);
    expect(summary[0].costKnown).toBe(false);
  });

  test("keeps models fully separate from each other", () => {
    const rows: BenchmarkResultRow[] = [
      row({ modelId: "a", costMicros: 100_000, latencyMs: 500 }),
      row({ modelId: "b", costMicros: 200_000, latencyMs: 1500 }),
    ];

    const summary = summarizeBenchmarkResultRows(rows);
    const a = summary.find((m) => m.modelId === "a");
    const b = summary.find((m) => m.modelId === "b");

    expect(a?.totalCostMicros).toBe(100_000);
    expect(a?.avgLatencyMs).toBe(500);
    expect(b?.totalCostMicros).toBe(200_000);
    expect(a?.costKnown).toBe(true);
    expect(b?.costKnown).toBe(true);
    expect(b?.avgLatencyMs).toBe(1500);
  });
});
