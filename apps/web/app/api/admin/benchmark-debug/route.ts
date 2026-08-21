import { NextResponse } from "next/server";
import {
  getBenchmarkRunResults,
  listRecentBenchmarkRuns,
} from "@/lib/db/benchmarks";
import { getDisabledModelIdSet } from "@/lib/db/model-overrides";
import { isModelHardBlocked } from "@/lib/model-availability";

export const maxDuration = 60;

// TEMPORARY diagnostic route -- dumps raw per-task benchmark_results
// rows (including error_message) across the N most recent runs, so a
// suspicious pass-rate can be root caused instead of guessed at. Gated
// by the same one-off AUDIT_ROUTE_SECRET(_LIVE) pattern as the other
// admin diagnostic routes. Delete once the current investigation is
// resolved.
export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runs = await listRecentBenchmarkRuns(10);
  const disabledIds = await getDisabledModelIdSet();

  const runSummaries = await Promise.all(
    runs.map(async (run) => {
      const results = await getBenchmarkRunResults(run.id);
      const byModel: Record<
        string,
        { passed: number; total: number; sampleErrors: string[] }
      > = {};
      for (const r of results) {
        byModel[r.modelId] ??= { passed: 0, total: 0, sampleErrors: [] };
        byModel[r.modelId].total += 1;
        if (r.passed) {
          byModel[r.modelId].passed += 1;
        } else if (
          r.errorMessage &&
          byModel[r.modelId].sampleErrors.length < 2
        ) {
          byModel[r.modelId].sampleErrors.push(r.errorMessage);
        }
      }
      const modelIds = run.modelIds as string[];
      const availability = Object.fromEntries(
        modelIds.map((id) => [
          id,
          {
            hardBlocked: isModelHardBlocked(id),
            adminDisabled: disabledIds.has(id),
          },
        ]),
      );
      return {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        modelIds,
        byModel,
        availability,
      };
    }),
  );

  return NextResponse.json({ runs: runSummaries });
}
