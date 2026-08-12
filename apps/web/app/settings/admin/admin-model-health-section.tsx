"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getAdminModelHealthReport } from "@/lib/admin/actions";
import type { AdminModelHealthRow } from "@/lib/db/admin-activity";
import { cn } from "@/lib/utils";

const HEALTH_DAYS = 7;

function healthBadgeClass(errorRatePct: number): string {
  if (errorRatePct >= 10) {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (errorRatePct >= 2) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-400";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
}

/**
 * Per-model reliability table -- surfaces the completed/aborted/failed
 * split and error rate for every model that ran a turn in the last 7
 * days, so a regressing provider/model shows up here before support
 * tickets do.
 */
export function AdminModelHealthSection() {
  const [data, setData] = useState<AdminModelHealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getAdminModelHealthReport(HEALTH_DAYS)
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load model health.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model health</CardTitle>
        <CardDescription>
          Completed / aborted / failed turns, last {HEALTH_DAYS} days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        ) : data ? (
          data.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No turns recorded in this window.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Turns</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">Aborted</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Error rate</TableHead>
                  <TableHead className="text-right">Avg duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row) => (
                  <TableRow key={row.modelId}>
                    <TableCell className="font-medium">{row.modelId}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.totalRuns}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.completedRuns}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.abortedRuns}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.failedRuns}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          "tabular-nums",
                          healthBadgeClass(row.errorRatePct),
                        )}
                      >
                        {row.errorRatePct.toFixed(1)}%
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {(row.avgDurationMs / 1000).toFixed(1)}s
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading model health…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
