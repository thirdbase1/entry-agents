"use client";

import { Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getProviderDisplayName,
  ProviderIcon,
} from "@/components/provider-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  getAdminModelCatalog,
  listAdminBenchmarkRuns,
  startAdminBenchmarkRun,
  type AdminModelCatalogRow,
} from "@/lib/admin/actions";
import type { BenchmarkRunWithProgress } from "@/lib/db/benchmarks";
import { cn } from "@/lib/utils";

const TASKS_PER_MODEL = 20; // fixed HumanEval subset size

function statusBadge(status: BenchmarkRunWithProgress["status"]) {
  if (status === "running") {
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
        Running
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-500">
        Failed
      </Badge>
    );
  }
  return <Badge variant="outline">Completed</Badge>;
}

function RunProgressRow({ run }: { readonly run: BenchmarkRunWithProgress }) {
  const totalExpected = run.modelIds.length * TASKS_PER_MODEL;
  const totalDone = run.modelIds.reduce(
    (sum, id) => sum + (run.progress[id]?.total ?? 0),
    0,
  );
  const pct = totalExpected > 0 ? (totalDone / totalExpected) * 100 : 0;

  return (
    <div className="space-y-2 border-b py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {statusBadge(run.status)}
          <span className="text-muted-foreground">
            {run.modelIds.length} model{run.modelIds.length === 1 ? "" : "s"}
            {run.triggeredBy ? ` -- ${run.triggeredBy}` : ""}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {new Date(run.startedAt).toLocaleString()}
        </span>
      </div>

      {run.status === "running" ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {run.modelIds.map((modelId) => {
          const bucket = run.progress[modelId];
          return (
            <span key={modelId} className="font-mono">
              {modelId}: {bucket?.total ?? 0}/{TASKS_PER_MODEL}
              {bucket ? ` (${bucket.passed} passed)` : ""}
            </span>
          );
        })}
      </div>

      {run.errorMessage ? (
        <p className="text-xs text-amber-500">{run.errorMessage}</p>
      ) : null}
    </div>
  );
}

/**
 * Admin control for the public benchmark suite: pick any subset of
 * live models, kick off a real HumanEval run against the actual agent
 * harness, and watch progress update every few seconds without leaving
 * the page. Polls listAdminBenchmarkRuns while any run is in flight;
 * the public /benchmarks page picks up the same data independently via
 * its own polling against /api/benchmarks/latest.
 */
export function AdminBenchmarksSection() {
  const [models, setModels] = useState<AdminModelCatalogRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<BenchmarkRunWithProgress[] | null>(null);
  const [starting, setStarting] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getAdminModelCatalog()
      .then((rows) => setModels(rows.filter((r) => !r.hardBlocked)))
      .catch(() => toast.error("Failed to load model catalog"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const rows = await listAdminBenchmarkRuns(10);
        if (!cancelled) setRuns(rows);
      } catch {
        // Transient -- next poll retries.
      }
    }
    refresh();
    intervalRef.current = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const anyRunning = useMemo(
    () => runs?.some((r) => r.status === "running") ?? false,
    [runs],
  );

  function toggleModel(modelId: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  }

  async function handleStart() {
    if (selected.size === 0) {
      toast.error("Select at least one model first.");
      return;
    }
    setStarting(true);
    try {
      const { runId } = await startAdminBenchmarkRun([...selected]);
      toast.success(
        `Benchmark run started (${selected.size} model${selected.size === 1 ? "" : "s"}) -- ${runId}`,
      );
      const rows = await listAdminBenchmarkRuns(10);
      setRuns(rows);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start run",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Run benchmarks</CardTitle>
          <CardDescription>
            Runs the real 20-task HumanEval subset through the actual agent
            harness for each selected model. Each run spends real metered API
            cost -- pick models deliberately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!models ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading models…
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {models.map((row) => (
                <div
                  key={row.id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
                    row.adminDisabled && "opacity-50",
                  )}
                >
                  <Label
                    htmlFor={`bench-model-${row.id}`}
                    className="flex min-w-0 items-center gap-2 font-normal"
                  >
                    <ProviderIcon
                      provider={row.provider}
                      className="size-4 shrink-0 opacity-80"
                    />
                    <span className="truncate">
                      {row.name}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({getProviderDisplayName(row.provider)})
                      </span>
                    </span>
                  </Label>
                  <Switch
                    id={`bench-model-${row.id}`}
                    checked={selected.has(row.id)}
                    onCheckedChange={(checked) => toggleModel(row.id, checked)}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleStart} disabled={starting || anyRunning}>
              {starting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Start run ({selected.size} selected)
            </Button>
            {anyRunning ? (
              <span className="text-xs text-muted-foreground">
                A run is already in progress -- wait for it to finish before
                starting another.
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            Updates automatically every few seconds while a run is active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!runs ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading runs…
            </div>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <div>
              {runs.map((run) => (
                <RunProgressRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
