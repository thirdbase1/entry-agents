"use client";

import { formatTokens } from "@open-agents/shared";
import { Loader2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAdminCompactionOverview } from "@/lib/admin/actions";
import type { CompactionOverview } from "@/lib/db/compaction";
import { AdminStatCard } from "./admin-stat-card";

type Overview = CompactionOverview & { eligibleTurns: number };

const RANGE_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AdminCompactionSection() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Overview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getAdminCompactionOverview(days)
      .then((overview) => {
        if (!cancelled) setData(overview);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [days]);

  const savingsPct =
    data && data.avgPreCompactTokens > 0
      ? Math.round(
          ((data.avgPreCompactTokens - data.avgPostCompactTokens) /
            data.avgPreCompactTokens) *
            100,
        )
      : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Compaction Activity
          </CardTitle>
          <div className="flex gap-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setDays(opt.days)}
                className={`rounded-md px-2 py-1 text-xs ${
                  days === opt.days
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <CardDescription>
          Auto-compaction firings recorded across all chats. Every time a
          turn&apos;s context crosses the threshold of the model&apos;s
          window, one row is written here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : data ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <AdminStatCard
                label="Firings"
                value={String(data.eventCount)}
              />
              <AdminStatCard
                label="Chats affected"
                value={String(data.chatCount)}
              />
              <AdminStatCard
                label="Avg tokens reclaimed"
                value={
                  savingsPct > 0
                    ? `${savingsPct}% per firing`
                    : "—"
                }
              />
              <AdminStatCard
                label="Near-window turns"
                value={String(data.eligibleTurns)}
              />
            </div>

            {data.eventCount === 0 ? (
              <p className="text-sm text-muted-foreground">
                {data.eligibleTurns > 0
                  ? `Zero firings recorded in ${days}d, but ${data.eligibleTurns} turns ran near the window limit — if this keeps showing, compaction may not be firing when it should.`
                  : `No compaction fired in the last ${days}d — contexts simply never approached the window threshold. That is expected behavior, not a bug.`}
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Last firing:{" "}
                  {data.latestEventAt
                    ? formatTime(data.latestEventAt)
                    : "unknown"}
                  {" · "}
                  Total reclaimed:{" "}
                  {formatTokens(data.totalTokensSaved)} tokens
                </p>
                <div className="max-h-64 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2 text-left font-medium">When</th>
                        <th className="p-2 text-left font-medium">Chat</th>
                        <th className="p-2 text-left font-medium">Model</th>
                        <th className="p-2 text-right font-medium">
                          Before → After
                        </th>
                        <th className="p-2 text-right font-medium">
                          % of window
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.events.map((e) => (
                        <tr key={e.id} className="border-t">
                          <td className="p-2">{formatTime(e.createdAt)}</td>
                          <td className="p-2 font-mono">
                            {e.chatId?.slice(0, 8) ?? "—"}
                          </td>
                          <td className="p-2">{e.modelId ?? "—"}</td>
                          <td className="p-2 text-right">
                            {formatTokens(e.preCompactTokens)} →{" "}
                            {formatTokens(e.postCompactTokens)}
                          </td>
                          <td className="p-2 text-right">
                            {Math.round(
                              (e.preCompactTokens / e.contextWindowTokens) *
                                100,
                            )}
                            %
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
