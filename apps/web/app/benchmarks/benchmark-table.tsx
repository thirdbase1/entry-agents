"use client";

import type { ModelBenchmarkSummary } from "@/lib/db/benchmarks";
import {
  ProviderIcon,
  getProviderDisplayName,
  getProviderFromModelId,
} from "@/components/provider-icons";
import { BENCHMARK_TRACKS } from "./benchmark-catalog";

function score(
  bucket: { passed: number; total: number } | undefined,
): number | null {
  if (!bucket || bucket.total === 0) return null;
  return (bucket.passed / bucket.total) * 100;
}

function formatScore(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatCost(micros: number, known: boolean): string {
  if (!known) return "—";
  if (micros === 0) return "Free";
  if (micros < 1_000) return "<$0.001";
  return `$${(micros / 1_000_000).toFixed(3)}`;
}

export function BenchmarkTable({
  models,
}: {
  readonly models: ModelBenchmarkSummary[];
}) {
  const tracks = BENCHMARK_TRACKS.filter((track) =>
    models.some(
      (model) =>
        (
          model.results as Record<
            string,
            { passed: number; total: number } | undefined
          >
        )[track.key],
    ),
  );
  const sorted = [...models].sort((a, b) => {
    const aScores = tracks
      .map((t) =>
        score(
          (
            a.results as Record<
              string,
              { passed: number; total: number } | undefined
            >
          )[t.key],
        ),
      )
      .filter((x): x is number => x != null);
    const bScores = tracks
      .map((t) =>
        score(
          (
            b.results as Record<
              string,
              { passed: number; total: number } | undefined
            >
          )[t.key],
        ),
      )
      .filter((x): x is number => x != null);
    const average = (values: number[]) =>
      values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : -1;
    return average(bScores) - average(aScores);
  });

  if (tracks.length === 0) {
    return (
      <div className="border border-(--l-border) px-6 py-16 text-center">
        <div className="text-sm font-medium">No Entry benchmark scores yet</div>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-(--l-fg-3)">
          The old HumanEval subset is no longer displayed. New results will
          appear here after the agent suite runs SWE-bench, Terminal-Bench,
          LiveCodeBench, and Aider Polyglot.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-(--l-border)">
      <div className="min-w-[920px]">
        <div className="grid grid-cols-[2fr_repeat(4,1fr)_0.8fr_0.8fr] gap-x-4 border-b border-(--l-border) bg-(--l-fg-6) px-4 py-3 text-[10px] font-medium uppercase tracking-wider text-(--l-fg-3) sm:px-6">
          <div>Model</div>
          {tracks.map((track) => (
            <div key={track.key} className="text-right">
              {track.shortName}
            </div>
          ))}
          <div className="text-right">Latency</div>
          <div className="text-right">Cost</div>
        </div>
        {sorted.map((model, index) => {
          const provider = getProviderFromModelId(model.modelId);
          return (
            <div
              key={model.modelId}
              className="grid grid-cols-[2fr_repeat(4,1fr)_0.8fr_0.8fr] items-center gap-x-4 border-b border-(--l-border) px-4 py-4 last:border-b-0 sm:px-6"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-5 text-xs text-(--l-fg-3)">{index + 1}</span>
                <ProviderIcon
                  provider={provider}
                  className="size-5 shrink-0 opacity-90"
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {model.modelId}
                  </div>
                  <div className="truncate text-xs text-(--l-fg-3)">
                    {getProviderDisplayName(provider)}
                  </div>
                </div>
              </div>
              {tracks.map((track) => {
                const value = score(
                  (
                    model.results as Record<
                      string,
                      { passed: number; total: number } | undefined
                    >
                  )[track.key],
                );
                return (
                  <div key={track.key} className="text-right">
                    <div className="text-sm font-medium">
                      {formatScore(value)}
                    </div>
                    {value != null ? (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-(--l-fg-6)">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${value}%`,
                            backgroundColor: track.color,
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <div className="text-right text-sm text-(--l-fg-2)">
                {formatLatency(model.avgLatencyMs)}
              </div>
              <div className="text-right text-sm text-(--l-fg-2)">
                {formatCost(model.totalCostMicros, model.costKnown)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
