"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelBenchmarkSummary } from "@/lib/db/benchmarks";
import { BenchmarkTable } from "./benchmark-table";

type RunStatus = "running" | "completed" | "failed";

export interface BenchmarkLiveSummary {
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  suiteVersion: string;
  modelIds: string[];
  models: ModelBenchmarkSummary[];
}

/** Fills in a zeroed placeholder for any model in the run that hasn't
 * recorded a single result yet, so it still shows up in the table as
 * "0/20" with a running indicator instead of being invisible. */
function mergeWithPlaceholders(
  summary: BenchmarkLiveSummary,
): ModelBenchmarkSummary[] {
  const known = new Map(summary.models.map((m) => [m.modelId, m]));
  return summary.modelIds.map(
    (modelId) =>
      known.get(modelId) ?? {
        modelId,
        results: {
          humaneval: undefined,
          swebench_verified: undefined,
          entry_tasks: undefined,
        },
        avgLatencyMs: null,
        totalCostCents: 0,
      },
  );
}

function totalProgress(summary: BenchmarkLiveSummary): {
  done: number;
  total: number;
} {
  const tasksPerModel = 20; // fixed HumanEval subset size (HUMANEVAL_SUITE_VERSION)
  const total = summary.modelIds.length * tasksPerModel;
  const done = summary.models.reduce(
    (sum, m) => sum + (m.results.humaneval?.total ?? 0),
    0,
  );
  return { done, total };
}

/**
 * Client wrapper around BenchmarkTable that polls the public
 * /api/benchmarks/latest endpoint every few seconds so new runs (or an
 * in-progress run) show up on the page without a manual refresh. Starts
 * from the server-rendered `initialSummary` for a flicker-free first
 * paint, then takes over via polling.
 */
export function BenchmarkLive({
  initialSummary,
}: {
  readonly initialSummary: BenchmarkLiveSummary | null;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch("/api/benchmarks/latest", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: { summary: BenchmarkLiveSummary | null } = await res.json();
        setSummary(data.summary);
      } catch {
        // Transient network blip -- next tick retries, no need to surface.
      }
    }

    intervalRef.current = setInterval(poll, 4000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  if (!summary) {
    return (
      <div className="border border-(--l-border) px-6 py-16 text-center text-(--l-fg-3)">
        No benchmark run yet.
      </div>
    );
  }

  const isRunning = summary.status === "running";
  const progress = totalProgress(summary);

  return (
    <div>
      {isRunning ? (
        <div className="mb-4 flex items-center gap-2 text-sm text-(--l-fg-2)">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          Benchmark running -- {progress.done}/{progress.total} tasks complete
        </div>
      ) : summary.status === "failed" ? (
        <div className="mb-4 text-sm text-amber-500">
          Last run had one or more errored tasks -- numbers below reflect what
          graded successfully.
        </div>
      ) : null}

      <BenchmarkTable models={mergeWithPlaceholders(summary)} />

      <p className="mt-8 text-sm text-(--l-fg-3)">
        HumanEval subset ({summary.suiteVersion}), 20 fixed tasks from the
        canonical OpenAI HumanEval dataset.{" "}
        {isRunning
          ? "This run is in progress -- numbers update automatically as tasks complete."
          : `Last run completed ${(summary.finishedAt ?? summary.startedAt).slice(0, 10)}.`}{" "}
        Cost shown is the real gateway-metered spend for running this subset,
        not a per-token rate.
      </p>
    </div>
  );
}
