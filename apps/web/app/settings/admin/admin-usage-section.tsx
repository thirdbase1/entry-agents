"use client";

import { formatTokens } from "@entry/shared";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAdminUsageOverview } from "@/lib/admin/actions";
import type { AdminPlatformUsageOverview } from "@/lib/db/admin-usage";
import { AdminStatCard } from "./admin-stat-card";

const RANGE_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

export function AdminUsageSection() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AdminPlatformUsageOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getAdminUsageOverview(days)
      .then((overview) => {
        if (!cancelled) setData(overview);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load usage data.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Platform Usage</h2>
        <div className="flex gap-1 rounded-md border p-0.5">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.days}
              type="button"
              onClick={() => setDays(option.days)}
              className={`rounded px-2 py-1 text-xs font-medium transition ${
                days === option.days
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading usage…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {!isLoading && !error && data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <AdminStatCard
              label="Active users"
              value={data.totalActiveUsers.toLocaleString()}
              description={`last ${data.rangeDays}d`}
            />
            <AdminStatCard
              label="Requests"
              value={data.totalEvents.toLocaleString()}
            />
            <AdminStatCard
              label="Tokens"
              value={formatTokens(
                data.totalInputTokens + data.totalOutputTokens,
              )}
              description={`${formatTokens(data.totalInputTokens)} in / ${formatTokens(data.totalOutputTokens)} out`}
            />
            <AdminStatCard
              label="Estimated spend"
              value={formatUsd(data.totalEstimatedCostUsd)}
              description={
                data.hasUnpricedUsage
                  ? "some models unpriced — actual spend may be higher"
                  : undefined
              }
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Usage by model</CardTitle>
              <CardDescription>
                Sorted by estimated spend, last {data.rangeDays} days.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {data.perModel.length === 0 && (
                  <p className="px-5 py-4 text-sm text-muted-foreground">
                    No usage in this range.
                  </p>
                )}
                {data.perModel.map((model) => (
                  <div
                    key={model.modelId}
                    className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{model.modelId}</p>
                      <p className="text-xs text-muted-foreground">
                        {model.provider ?? "unknown provider"} ·{" "}
                        {model.eventCount.toLocaleString()} requests ·{" "}
                        {formatTokens(
                          model.totalInputTokens + model.totalOutputTokens,
                        )}{" "}
                        tokens
                      </p>
                    </div>
                    <p className="shrink-0 tabular-nums text-muted-foreground">
                      {model.estimatedCostUsd === undefined
                        ? "unpriced"
                        : formatUsd(model.estimatedCostUsd)}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Top spenders</CardTitle>
              <CardDescription>
                Top {data.topUsers.length} users by estimated spend, last{" "}
                {data.rangeDays} days.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {data.topUsers.length === 0 && (
                  <p className="px-5 py-4 text-sm text-muted-foreground">
                    No usage in this range.
                  </p>
                )}
                {data.topUsers.map((user, index) => (
                  <div
                    key={user.userId}
                    className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="w-5 shrink-0 text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {user.name ?? user.username}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.email ?? user.username}
                        </p>
                      </div>
                    </div>
                    <p className="shrink-0 tabular-nums text-muted-foreground">
                      {formatUsd(user.estimatedCostUsd)}
                      {user.hasUnpricedUsage ? "+" : ""}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
