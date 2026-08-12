import { sql } from "drizzle-orm";
import { db } from "./client";
import { workflowRuns } from "./schema";

export interface AdminActivityDayRow {
  /** YYYY-MM-DD, UTC. */
  date: string;
  totalRuns: number;
  failedRuns: number;
}

export interface AdminModelHealthRow {
  modelId: string;
  totalRuns: number;
  completedRuns: number;
  abortedRuns: number;
  failedRuns: number;
  errorRatePct: number;
  avgDurationMs: number;
}

/**
 * Daily turn volume + failure count for the last `days` days (including
 * today), zero-filled for days with no runs, for the admin activity
 * chart. Sourced from `workflow_runs` -- one row per agent turn.
 */
export async function getAdminActivityTrend(
  days = 14,
): Promise<AdminActivityDayRow[]> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${workflowRuns.startedAt}), 'YYYY-MM-DD')`,
      totalRuns: sql<number>`count(*)::int`,
      failedRuns: sql<number>`coalesce(sum(case when ${workflowRuns.status} = 'failed' then 1 else 0 end), 0)::int`,
    })
    .from(workflowRuns)
    .where(sql`${workflowRuns.startedAt} >= ${since.toISOString()}`)
    .groupBy(sql`date_trunc('day', ${workflowRuns.startedAt})`);

  const byDay = new Map(rows.map((row) => [row.day, row]));
  const result: AdminActivityDayRow[] = [];

  for (let i = 0; i < days; i++) {
    const day = new Date(since);
    day.setUTCDate(since.getUTCDate() + i);
    const key = day.toISOString().slice(0, 10);
    const found = byDay.get(key);
    result.push({
      date: key,
      totalRuns: found?.totalRuns ?? 0,
      failedRuns: found?.failedRuns ?? 0,
    });
  }

  return result;
}

/**
 * Per-model reliability breakdown over the last `days` days -- surfaces
 * which models are erroring out or aborting so an admin can spot a bad
 * provider/model before users complain. Sourced from `workflow_runs`.
 */
export async function getAdminModelHealth(
  days = 7,
): Promise<AdminModelHealthRow[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select({
      modelId: workflowRuns.modelId,
      totalRuns: sql<number>`count(*)::int`,
      completedRuns: sql<number>`coalesce(sum(case when ${workflowRuns.status} = 'completed' then 1 else 0 end), 0)::int`,
      abortedRuns: sql<number>`coalesce(sum(case when ${workflowRuns.status} = 'aborted' then 1 else 0 end), 0)::int`,
      failedRuns: sql<number>`coalesce(sum(case when ${workflowRuns.status} = 'failed' then 1 else 0 end), 0)::int`,
      avgDurationMs: sql<number>`coalesce(avg(${workflowRuns.totalDurationMs}), 0)::int`,
    })
    .from(workflowRuns)
    .where(sql`${workflowRuns.startedAt} >= ${since.toISOString()}`)
    .groupBy(workflowRuns.modelId);

  return rows
    .map((row) => ({
      modelId: row.modelId ?? "unknown",
      totalRuns: row.totalRuns,
      completedRuns: row.completedRuns,
      abortedRuns: row.abortedRuns,
      failedRuns: row.failedRuns,
      errorRatePct:
        row.totalRuns > 0 ? (row.failedRuns / row.totalRuns) * 100 : 0,
      avgDurationMs: row.avgDurationMs,
    }))
    .toSorted((a, b) => b.totalRuns - a.totalRuns);
}

export interface AdminModelAlertRow {
  modelId: string;
  totalRuns: number;
  failedRuns: number;
  errorRatePct: number;
  windowHours: number;
}

/** Default lookback window for the live error-rate alert check. */
export const MODEL_ALERT_WINDOW_HOURS = 24;
/** Minimum sample size before a model's error rate is trusted. */
export const MODEL_ALERT_MIN_RUNS = 5;
/** Error rate (%) above which a model is flagged as unhealthy. */
export const MODEL_ALERT_ERROR_RATE_THRESHOLD_PCT = 15;

/**
 * Models whose recent error rate has crossed the alert threshold --
 * feeds the admin dashboard's alert banner. Deliberately windowed much
 * tighter (24h) than the 7-day model-health table so a fresh regression
 * (bad deploy, provider outage) surfaces fast, and gated on a minimum
 * sample size so a model with 1 failed run out of 2 doesn't false-alarm.
 */
export async function getAdminModelAlerts(
  windowHours = MODEL_ALERT_WINDOW_HOURS,
  minRuns = MODEL_ALERT_MIN_RUNS,
  errorRateThresholdPct = MODEL_ALERT_ERROR_RATE_THRESHOLD_PCT,
): Promise<AdminModelAlertRow[]> {
  const since = new Date();
  since.setHours(since.getHours() - windowHours);

  const rows = await db
    .select({
      modelId: workflowRuns.modelId,
      totalRuns: sql<number>`count(*)::int`,
      failedRuns: sql<number>`coalesce(sum(case when ${workflowRuns.status} = 'failed' then 1 else 0 end), 0)::int`,
    })
    .from(workflowRuns)
    .where(sql`${workflowRuns.startedAt} >= ${since.toISOString()}`)
    .groupBy(workflowRuns.modelId);

  return rows
    .map((row) => ({
      modelId: row.modelId ?? "unknown",
      totalRuns: row.totalRuns,
      failedRuns: row.failedRuns,
      errorRatePct:
        row.totalRuns > 0 ? (row.failedRuns / row.totalRuns) * 100 : 0,
      windowHours,
    }))
    .filter(
      (row) =>
        row.totalRuns >= minRuns && row.errorRatePct >= errorRateThresholdPct,
    )
    .toSorted((a, b) => b.errorRatePct - a.errorRatePct);
}
