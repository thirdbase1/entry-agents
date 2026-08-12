"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getAdminActivity } from "@/lib/admin/actions";
import type { AdminActivityDayRow } from "@/lib/db/admin-activity";

const CHART_DAYS = 14;
const MIN_BAR_HEIGHT_PX = 3;
const MAX_BAR_HEIGHT_PX = 88;

function formatShortDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatWeekday(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
  });
}

/**
 * Daily agent-turn volume for the last 14 days as a simple bar chart --
 * the failed portion of each bar is rendered in the destructive token so
 * a bad-deploy spike in errors is visible at a glance without opening
 * logs.
 */
export function AdminActivityChart() {
  const [data, setData] = useState<AdminActivityDayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getAdminActivity(CHART_DAYS)
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load activity trend.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const maxRuns = data ? Math.max(1, ...data.map((day) => day.totalRuns)) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Agent turns per day, last {CHART_DAYS} days. Red = failed turns.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        ) : data ? (
          <div className="flex h-[120px] items-end gap-1.5">
            {data.map((day) => {
              const totalHeight =
                day.totalRuns === 0
                  ? MIN_BAR_HEIGHT_PX
                  : Math.max(
                      MIN_BAR_HEIGHT_PX,
                      (day.totalRuns / maxRuns) * MAX_BAR_HEIGHT_PX,
                    );
              const failedHeight =
                day.totalRuns > 0
                  ? (day.failedRuns / day.totalRuns) * totalHeight
                  : 0;

              return (
                <Tooltip key={day.date}>
                  <TooltipTrigger asChild>
                    <div className="flex flex-1 flex-col items-center gap-1.5">
                      <div
                        className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-muted"
                        style={{ height: MAX_BAR_HEIGHT_PX }}
                      >
                        <div
                          className="w-full bg-primary/70"
                          style={{ height: totalHeight }}
                        >
                          {failedHeight > 0 && (
                            <div
                              className="w-full bg-destructive"
                              style={{ height: failedHeight }}
                            />
                          )}
                        </div>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {formatWeekday(day.date)}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">{formatShortDate(day.date)}</p>
                    <p>{day.totalRuns} turns</p>
                    {day.failedRuns > 0 && (
                      <p className="text-destructive">
                        {day.failedRuns} failed
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading activity…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
