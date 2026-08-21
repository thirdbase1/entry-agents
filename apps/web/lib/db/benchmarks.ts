import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./client";
import { benchmarkResults, benchmarkRuns } from "./schema";

export type BenchmarkName = "humaneval" | "swebench_verified" | "entry_tasks";

/**
 * Creates a new "running" benchmark run row. Only ever called from the
 * admin-triggered runner script (scripts/run-benchmarks.ts) or a
 * scheduled job -- never from a public request path. See schema.ts's
 * comment on benchmarkRuns for why the public page never triggers a
 * live run itself.
 */
export async function createBenchmarkRun(data: {
  suiteVersion: string;
  modelIds: string[];
  triggeredBy?: string;
}): Promise<string> {
  const id = nanoid();
  await db.insert(benchmarkRuns).values({
    id,
    status: "running",
    suiteVersion: data.suiteVersion,
    modelIds: data.modelIds,
    triggeredBy: data.triggeredBy ?? null,
  });
  return id;
}

export async function recordBenchmarkResult(data: {
  runId: string;
  modelId: string;
  benchmark: BenchmarkName;
  taskId: string;
  passed: boolean;
  latencyMs?: number;
  costCents?: number;
  errorMessage?: string;
  transcriptUrl?: string;
}): Promise<void> {
  await db.insert(benchmarkResults).values({
    id: nanoid(),
    runId: data.runId,
    modelId: data.modelId,
    benchmark: data.benchmark,
    taskId: data.taskId,
    passed: data.passed,
    latencyMs: data.latencyMs ?? null,
    costCents: data.costCents ?? null,
    errorMessage: data.errorMessage ?? null,
    transcriptUrl: data.transcriptUrl ?? null,
  });
}

export async function completeBenchmarkRun(
  runId: string,
  status: "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  await db
    .update(benchmarkRuns)
    .set({ status, finishedAt: new Date(), errorMessage: errorMessage ?? null })
    .where(eq(benchmarkRuns.id, runId));
}

export type ModelBenchmarkSummary = {
  modelId: string;
  results: Record<BenchmarkName, { passed: number; total: number } | undefined>;
  avgLatencyMs: number | null;
  totalCostCents: number;
};

export type LatestBenchmarkSummary = {
  runId: string;
  finishedAt: Date;
  suiteVersion: string;
  models: ModelBenchmarkSummary[];
};

export type BenchmarkResultRow = {
  modelId: string;
  benchmark: BenchmarkName;
  passed: boolean;
  latencyMs: number | null;
  costCents: number | null;
};

/**
 * Pure aggregation over already-fetched result rows for a single run --
 * split out from getLatestCompletedBenchmarkSummary so it's testable
 * without a real DB connection (see benchmarks.test.ts).
 */
export function summarizeBenchmarkResultRows(
  rows: BenchmarkResultRow[],
): ModelBenchmarkSummary[] {
  const byModel = new Map<string, ModelBenchmarkSummary>();

  for (const row of rows) {
    let entry = byModel.get(row.modelId);
    if (!entry) {
      entry = {
        modelId: row.modelId,
        results: {
          humaneval: undefined,
          swebench_verified: undefined,
          entry_tasks: undefined,
        },
        avgLatencyMs: null,
        totalCostCents: 0,
      };
      byModel.set(row.modelId, entry);
    }

    const bucket = entry.results[row.benchmark] ?? {
      passed: 0,
      total: 0,
    };
    bucket.total += 1;
    if (row.passed) bucket.passed += 1;
    entry.results[row.benchmark] = bucket;
    entry.totalCostCents += row.costCents ?? 0;
  }

  // second pass for avg latency per model
  for (const [modelId, entry] of byModel) {
    const modelRows = rows.filter(
      (r) => r.modelId === modelId && r.latencyMs != null,
    );
    entry.avgLatencyMs = modelRows.length
      ? Math.round(
          modelRows.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) /
            modelRows.length,
        )
      : null;
  }

  return [...byModel.values()];
}

/**
 * Reads the most recently *completed* run and aggregates its results
 * per model. Kept around for callers that specifically want to ignore
 * in-flight runs; the public /benchmarks page itself now calls
 * getLatestBenchmarkRunSummary (below) so live progress shows up
 * immediately instead of waiting for the whole suite to finish.
 */
export async function getLatestCompletedBenchmarkSummary(): Promise<LatestBenchmarkSummary | null> {
  const [run] = await db
    .select()
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.status, "completed"))
    .orderBy(desc(benchmarkRuns.finishedAt))
    .limit(1);

  if (!run || !run.finishedAt) return null;

  const rows = await db
    .select()
    .from(benchmarkResults)
    .where(eq(benchmarkResults.runId, run.id));

  return {
    runId: run.id,
    finishedAt: run.finishedAt,
    suiteVersion: run.suiteVersion,
    models: summarizeBenchmarkResultRows(rows),
  };
}

export type LatestBenchmarkRunSummary = {
  runId: string;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  suiteVersion: string;
  /** Every model this run covers, in run order -- includes models with
   * zero results recorded yet (haven't started their first task). */
  modelIds: string[];
  models: ModelBenchmarkSummary[];
};

/**
 * Reads the single most recent run *regardless of status* and
 * aggregates whatever results have landed so far. This is what powers
 * "instant" visibility on the public page and the admin live-progress
 * view -- a run in progress shows up immediately with partial numbers
 * instead of only appearing once every task across every model is
 * done. `models` only contains entries for models with at least one
 * recorded result; merge against `modelIds` for models still at 0/N.
 */
export async function getLatestBenchmarkRunSummary(): Promise<LatestBenchmarkRunSummary | null> {
  const [run] = await db
    .select()
    .from(benchmarkRuns)
    .orderBy(desc(benchmarkRuns.startedAt))
    .limit(1);

  if (!run) return null;

  const rows = await db
    .select()
    .from(benchmarkResults)
    .where(eq(benchmarkResults.runId, run.id));

  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    suiteVersion: run.suiteVersion,
    modelIds: run.modelIds as string[],
    models: summarizeBenchmarkResultRows(rows),
  };
}

/** Admin-only: list recent runs (including in-flight/failed) for the admin dashboard. */
export async function listRecentBenchmarkRuns(limit = 20) {
  return db
    .select()
    .from(benchmarkRuns)
    .orderBy(desc(benchmarkRuns.startedAt))
    .limit(limit);
}

export async function getBenchmarkRunResults(runId: string) {
  return db
    .select()
    .from(benchmarkResults)
    .where(and(eq(benchmarkResults.runId, runId)));
}

export type BenchmarkRunWithProgress = {
  id: string;
  status: "running" | "completed" | "failed";
  suiteVersion: string;
  modelIds: string[];
  startedAt: Date;
  finishedAt: Date | null;
  triggeredBy: string | null;
  errorMessage: string | null;
  /** modelId -> tasks passed/total recorded so far this run. */
  progress: Record<string, { passed: number; total: number }>;
};

/**
 * Admin-only: recent runs (any status) each paired with live per-model
 * task counts, for the admin benchmarks page's polling progress view.
 */
export async function listRecentBenchmarkRunsWithProgress(
  limit = 10,
): Promise<BenchmarkRunWithProgress[]> {
  const runs = await listRecentBenchmarkRuns(limit);

  return Promise.all(
    runs.map(async (run) => {
      const rows = await getBenchmarkRunResults(run.id);
      const progress: Record<string, { passed: number; total: number }> = {};
      for (const row of rows) {
        const bucket = progress[row.modelId] ?? { passed: 0, total: 0 };
        bucket.total += 1;
        if (row.passed) bucket.passed += 1;
        progress[row.modelId] = bucket;
      }
      return {
        id: run.id,
        status: run.status,
        suiteVersion: run.suiteVersion,
        modelIds: run.modelIds as string[],
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        triggeredBy: run.triggeredBy,
        errorMessage: run.errorMessage,
        progress,
      };
    }),
  );
}
