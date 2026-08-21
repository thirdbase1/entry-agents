"use client";

import type { ModelBenchmarkSummary } from "@/lib/db/benchmarks";
import {
  ProviderIcon,
  getProviderDisplayName,
  getProviderFromModelId,
} from "@/components/provider-icons";

function formatPassRate(
  bucket: { passed: number; total: number } | undefined,
): string {
  if (!bucket || bucket.total === 0) return "—";
  return `${bucket.passed}/${bucket.total}`;
}

function passRateFraction(
  bucket: { passed: number; total: number } | undefined,
): number {
  if (!bucket || bucket.total === 0) return -1;
  return bucket.passed / bucket.total;
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatCost(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(3)}`;
}

export function BenchmarkTable({
  models,
}: {
  readonly models: ModelBenchmarkSummary[];
}) {
  const sorted = [...models].sort(
    (a, b) =>
      passRateFraction(b.results.humaneval) -
      passRateFraction(a.results.humaneval),
  );

  return (
    <div className="overflow-hidden border border-(--l-border)">
      <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-x-4 border-b border-(--l-border) bg-(--l-fg-6) px-4 py-3 text-xs font-medium uppercase tracking-wide text-(--l-fg-3) sm:px-6">
        <div>Model</div>
        <div className="text-right">HumanEval</div>
        <div className="hidden text-right sm:block">Avg latency</div>
        <div className="hidden text-right sm:block">Cost (subset)</div>
      </div>

      {sorted.map((model) => {
        const provider = getProviderFromModelId(model.modelId);
        const fraction = passRateFraction(model.results.humaneval);
        return (
          <div
            key={model.modelId}
            className="grid grid-cols-[2fr_1fr_1fr_1fr] items-center gap-x-4 border-b border-(--l-border) px-4 py-4 last:border-b-0 sm:px-6"
          >
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon
                provider={provider}
                className="size-5 shrink-0 opacity-90"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium sm:text-base">
                  {model.modelId}
                </div>
                <div className="truncate text-xs text-(--l-fg-3)">
                  {getProviderDisplayName(provider)}
                </div>
              </div>
            </div>

            <div className="text-right">
              <div
                className={
                  fraction >= 0.8
                    ? "text-sm font-medium text-emerald-500 sm:text-base"
                    : fraction >= 0.5
                      ? "text-sm font-medium text-amber-500 sm:text-base"
                      : "text-sm font-medium text-(--l-fg) sm:text-base"
                }
              >
                {formatPassRate(model.results.humaneval)}
              </div>
            </div>

            <div className="hidden text-right text-sm text-(--l-fg-2) sm:block">
              {formatLatency(model.avgLatencyMs)}
            </div>

            <div className="hidden text-right text-sm text-(--l-fg-2) sm:block">
              {formatCost(model.totalCostCents)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
